/**
 * meetings.js — Project meeting scheduling with email invites + RSVP.
 *
 * Routes:
 *   GET  /projects/:id/schedule            — Schedule page for a project
 *   GET  /projects/:id/schedule/new         — New meeting form
 *   POST /projects/:id/schedule             — Create meeting + send invites
 *   GET  /meetings/:id                      — Meeting detail
 *   POST /meetings/:id/edit                 — Edit meeting
 *   POST /meetings/:id/delete               — Delete meeting
 *   POST /meetings/:id/send-invites         — Re-send invites
 *   POST /meetings/:id/send-reminder        — Send reminder
 *   GET  /meetings/rsvp                     — RSVP via token (no auth)
 *   GET  /api/meetings/check-reminders      — Cron: send pending reminders
 */
const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const { requireAuth, requireManager, setFlash } = require('../middleware/auth');
const crypto = require('crypto');

const REMINDER_WINDOWS = {
  '1d':  24 * 60,
  '12h': 12 * 60,
  '6h':  6 * 60,
  '1h':  60,
};

// ── Helpers ──────────────────────────────────────────────────────────────

function escapeHtml(s) {
  if (typeof s !== 'string') return s || '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function formatDateTime(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return dt.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function computeEndTime(start, minutes) {
  const s = new Date(start);
  return new Date(s.getTime() + minutes * 60000).toISOString();
}

const BASE = process.env.PUBLIC_BASE_URL || 'https://forge-recon.vercel.app';

// ── Middleware: load project meeting with attendees ──────────────────────

async function loadMeeting(meetingId) {
  const { data: meeting } = await supabase
    .from('project_meetings')
    .select('*, users!project_meetings_created_by_user_id_fkey(name, email)')
    .eq('id', meetingId)
    .maybeSingle();
  if (!meeting) return null;
  const { data: attendees } = await supabase
    .from('meeting_attendees')
    .select('*, users!inner(id, name, email)')
    .eq('meeting_id', meetingId)
    .order('created_at');
  return { ...meeting, attendees: attendees || [] };
}

// ── GET /projects/:id/schedule — Schedule tab for a project ──────────────

router.get('/projects/:id/schedule', requireAuth, async (req, res) => {
  const jobId = req.params.id;
  // Verify project exists
  const { data: job } = await supabase.from('jobs').select('id, title').eq('id', jobId).maybeSingle();
  if (!job) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Project not found.' });

  const { data: meetings } = await supabase
    .from('project_meetings')
    .select('*')
    .eq('job_id', jobId)
    .order('start_time', { ascending: true });

  // Load attendee counts per meeting
  const meetingsWithAttendees = await Promise.all((meetings || []).map(async (m) => {
    const { data: atts } = await supabase
      .from('meeting_attendees')
      .select('response, users(id, name, email)')
      .eq('meeting_id', m.id);
    return { ...m, attendees: atts || [] };
  }));

  // Group past/future
  const now = new Date().toISOString();
  const upcoming = meetingsWithAttendees.filter(m => m.start_time >= now);
  const past = meetingsWithAttendees.filter(m => m.start_time < now);

  res.render('meetings/index', {
    title: `Schedule — ${job.title}`,
    activeNav: 'projects',
    job,
    upcoming,
    past,
    formatDateTime,
    computeEndTime,
  });
});

// ── GET /projects/:id/schedule/new ───────────────────────────────────────

router.get('/projects/:id/schedule/new', requireAuth, requireManager, async (req, res) => {
  const { data: job } = await supabase.from('jobs').select('id, title').eq('id', req.params.id).maybeSingle();
  if (!job) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Project not found.' });

  const { data: projectMembers } = await supabase
    .from('job_members')
    .select('user_id, role, users!inner(id, name, email)')
    .eq('job_id', job.id);

  const { data: allUsers } = await supabase
    .from('users')
    .select('id, name, email')
    .eq('active', 1)
    .order('name');

  // De-duplicate: members + all users
  const memberIds = new Set((projectMembers || []).map(m => m.user_id));
  const users = (allUsers || []).map(u => ({
    ...u,
    isMember: memberIds.has(u.id),
  }));

  res.render('meetings/new', {
    title: `New meeting — ${job.title}`,
    activeNav: 'projects',
    job,
    users,
    errors: {},
    form: {},
  });
});

// ── POST /projects/:id/schedule — Create meeting ────────────────────────

router.post('/projects/:id/schedule', requireAuth, requireManager, async (req, res) => {
  const jobId = req.params.id;
  const { data: job } = await supabase.from('jobs').select('id, title').eq('id', jobId).maybeSingle();
  if (!job) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Project not found.' });

  const errors = {};
  const form = {
    title: (req.body.title || '').trim(),
    description: (req.body.description || '').trim(),
    location: (req.body.location || '').trim(),
    meeting_link: (req.body.meeting_link || '').trim(),
    start_time: req.body.start_time || '',
    duration_minutes: parseInt(req.body.duration_minutes, 10) || 60,
    reminder_setting: req.body.reminder_setting || '1d',
    attendee_ids: [].concat(req.body.attendee_ids || []).filter(Boolean).map(Number),
  };

  if (!form.title) errors.title = 'Title is required.';
  if (!form.start_time) errors.start_time = 'Start time is required.';
  if (form.duration_minutes < 15) errors.duration_minutes = 'Minimum 15 minutes.';
  if (form.duration_minutes > 480) errors.duration_minutes = 'Maximum 8 hours.';
  if (!['none','1d','12h','6h','1h'].includes(form.reminder_setting)) form.reminder_setting = '1d';

  if (Object.keys(errors).length) {
    const { data: allUsers } = await supabase.from('users').select('id, name, email').eq('active', 1).order('name');
    return res.status(400).render('meetings/new', {
      title: `New meeting — ${job.title}`,
      activeNav: 'projects', job, users: allUsers || [], errors, form,
    });
  }

  try {
    // Insert meeting
    const { data: meeting, error: mErr } = await supabase
      .from('project_meetings')
      .insert({
        job_id: parseInt(jobId, 10),
        created_by_user_id: req.session.userId,
        title: form.title,
        description: form.description || null,
        location: form.location || null,
        meeting_link: form.meeting_link || null,
        start_time: form.start_time,
        duration_minutes: form.duration_minutes,
        reminder_setting: form.reminder_setting,
      })
      .select()
      .single();
    if (mErr) throw mErr;

    // Insert attendees + generate RSVP tokens
    const attendeeRows = [];
    for (const uid of form.attendee_ids) {
      const token = crypto.randomBytes(24).toString('hex');
      attendeeRows.push({ meeting_id: meeting.id, user_id: uid, rsvp_token: token });
    }
    if (attendeeRows.length) {
      const { error: aErr } = await supabase.from('meeting_attendees').insert(attendeeRows);
      if (aErr) throw aErr;
    }

    // Send invite emails in background
    try {
      const meetingsService = require('../services/meetings');
      await meetingsService.sendMeetingInvites(meeting.id);
    } catch (emailErr) {
      console.warn('[meetings] invite email send failed:', emailErr.message);
    }

    setFlash(req, 'success', `Meeting "${form.title}" created. Invites sent.`);
    res.redirect(`/projects/${jobId}/schedule`);
  } catch (err) {
    setFlash(req, 'error', 'Could not create meeting: ' + (err.message || err));
    res.redirect(`/projects/${jobId}/schedule/new`);
  }
});

// ── POST /meetings/:id/edit ─────────────────────────────────────────────

router.post('/meetings/:id/edit', requireAuth, requireManager, async (req, res) => {
  const meetingId = req.params.id;
  const { data: meeting } = await supabase.from('project_meetings').select('*').eq('id', meetingId).maybeSingle();
  if (!meeting) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Meeting not found.' });

  const updates = {};
  if (req.body.title) updates.title = req.body.title.trim();
  if (req.body.description !== undefined) updates.description = req.body.description.trim() || null;
  if (req.body.location !== undefined) updates.location = req.body.location.trim() || null;
  if (req.body.meeting_link !== undefined) updates.meeting_link = req.body.meeting_link.trim() || null;
  if (req.body.start_time) updates.start_time = req.body.start_time;
  if (req.body.duration_minutes) updates.duration_minutes = parseInt(req.body.duration_minutes, 10);
  if (req.body.reminder_setting && ['none','1d','12h','6h','1h'].includes(req.body.reminder_setting)) {
    updates.reminder_setting = req.body.reminder_setting;
  }
  updates.updated_at = new Date().toISOString();

  const { error } = await supabase.from('project_meetings').update(updates).eq('id', meetingId);
  if (error) { setFlash(req, 'error', 'Update failed: ' + error.message); return res.redirect(`/projects/${meeting.job_id}/schedule`); }
  setFlash(req, 'success', 'Meeting updated.');
  res.redirect(`/projects/${meeting.job_id}/schedule`);
});

// ── POST /meetings/:id/delete ───────────────────────────────────────────

router.post('/meetings/:id/delete', requireAuth, requireManager, async (req, res) => {
  const { data: meeting } = await supabase.from('project_meetings').select('id, job_id, title').eq('id', req.params.id).maybeSingle();
  if (!meeting) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Meeting not found.' });
  await supabase.from('project_meetings').delete().eq('id', meeting.id);
  setFlash(req, 'success', `Meeting "${meeting.title}" deleted.`);
  res.redirect(`/projects/${meeting.job_id}/schedule`);
});

// ── POST /meetings/:id/send-invites — Re-send invites ───────────────────

router.post('/meetings/:id/send-invites', requireAuth, requireManager, async (req, res) => {
  const { data: meeting } = await supabase.from('project_meetings').select('id, job_id, title').eq('id', req.params.id).maybeSingle();
  if (!meeting) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Meeting not found.' });
  try {
    const meetingsService = require('../services/meetings');
    await meetingsService.sendMeetingInvites(meeting.id);
    setFlash(req, 'success', 'Invites re-sent.');
  } catch (e) {
    setFlash(req, 'error', 'Failed to send invites: ' + e.message);
  }
  res.redirect(`/projects/${meeting.job_id}/schedule`);
});

// ── POST /meetings/:id/send-reminder ────────────────────────────────────

router.post('/meetings/:id/send-reminder', requireAuth, requireManager, async (req, res) => {
  try {
    const meetingsService = require('../services/meetings');
    const sent = await meetingsService.sendReminderForMeeting(req.params.id);
    setFlash(req, 'success', `Reminder sent to ${sent} attendee(s).`);
  } catch (e) {
    setFlash(req, 'error', 'Reminder failed: ' + e.message);
  }
  const { data: m } = await supabase.from('project_meetings').select('job_id').eq('id', req.params.id).single();
  res.redirect(`/projects/${m?.job_id || 0}/schedule`);
});

// ── GET /meetings/rsvp — RSVP via token (no auth required) ──────────────

router.get('/meetings/rsvp', async (req, res) => {
  const token = req.query.token || '';
  const response = req.query.response || '';

  if (!['accept','decline','maybe'].includes(response)) {
    return res.status(400).send('Invalid RSVP response. Use accept, decline, or maybe.');
  }

  const { data: attendee } = await supabase
    .from('meeting_attendees')
    .select('*, project_meetings!inner(id, title, start_time, location, meeting_link), users!inner(name, email)')
    .eq('rsvp_token', token)
    .maybeSingle();

  if (!attendee) return res.status(404).send('Invalid or expired RSVP link.');

  // Record response
  const { error } = await supabase
    .from('meeting_attendees')
    .update({ response, responded_at: new Date().toISOString() })
    .eq('id', attendee.id);

  if (error) return res.status(500).send('Could not save your response. Please try again.');

  res.send(`
    <!DOCTYPE html><html lang="en"><head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>RSVP received</title>
    <style>body{font-family:Inter,sans-serif;display:flex;align-items:center;justify-content:center;min-height:80vh;background:#f5f5f5;margin:0}
    .card{background:#fff;border-radius:12px;padding:40px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.08);max-width:420px}
    .check{font-size:48px;margin-bottom:12px}
    h1{font-size:20px;margin:0 0 8px;color:#1a1a1a}
    p{font-size:14px;color:#666;margin:0 0 4px}
    .meeting-title{font-weight:600;color:#c0202b;margin:8px 0}</style>
    </head><body>
    <div class="card">
      <div class="check">${response === 'accept' ? '✅' : response === 'decline' ? '❌' : '❓'}</div>
      <h1>${response === 'accept' ? 'You\'re in!' : response === 'decline' ? 'Maybe next time' : 'Marked as maybe'}</h1>
      <p>Your response has been recorded for:</p>
      <p class="meeting-title">${escapeHtml(attendee.project_meetings.title)}</p>
      <p style="font-size:12px;color:#999;margin-top:16px">You can close this page.</p>
    </div>
    </body></html>
  `);
});

// ── GET /api/meetings/check-reminders — Cron trigger ────────────────────

router.get('/api/meetings/check-reminders', async (req, res) => {
  const secret = req.query.secret;
  const isVercelCron = req.headers['x-vercel-cron'];
  if (!isVercelCron && secret !== process.env.CRON_SECRET && process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const now = new Date();
  const meetingsService = require('../services/meetings');
  let totalSent = 0;
  let errors = [];

  // Find meetings where reminders are due (reminder_setting != 'none', reminder_sent_at is null, start_time is in the future)
  const { data: meetings } = await supabase
    .from('project_meetings')
    .select('*')
    .neq('reminder_setting', 'none')
    .is('reminder_sent_at', null)
    .gt('start_time', now.toISOString());

  for (const meeting of meetings || []) {
    const windowMin = REMINDER_WINDOWS[meeting.reminder_setting];
    if (!windowMin) continue;
    const reminderTime = new Date(new Date(meeting.start_time).getTime() - windowMin * 60000);
    // Send if it's within 5 minutes of the reminder window
    const diff = Math.abs(now.getTime() - reminderTime.getTime());
    if (diff < 5 * 60 * 1000) {
      try {
        const sent = await meetingsService.sendReminderForMeeting(meeting.id);
        await supabase.from('project_meetings').update({ reminder_sent_at: now.toISOString() }).eq('id', meeting.id);
        totalSent += sent;
      } catch (e) {
        errors.push(`Meeting ${meeting.id}: ${e.message}`);
      }
    }
  }

  res.json({ ok: true, reminders_sent: totalSent, errors: errors.length ? errors : undefined });
});

module.exports = router;
