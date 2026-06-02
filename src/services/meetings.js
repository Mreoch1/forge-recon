/**
 * meetings.js — Meeting invite and reminder email service.
 */
const supabase = require('../db/supabase');
const emailService = require('./email');

const BASE = process.env.PUBLIC_BASE_URL || 'https://forge-recon.vercel.app';

function escapeHtml(s) {
  if (typeof s !== 'string') return s || '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function formatDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/**
 * Load a meeting with its attendees (including user details).
 */
async function loadMeetingWithAttendees(meetingId) {
  const { data: meeting } = await supabase
    .from('project_meetings')
    .select('*, users!project_meetings_created_by_user_id_fkey(name, email)')
    .eq('id', meetingId)
    .maybeSingle();
  if (!meeting) return null;
  const { data: attendees } = await supabase
    .from('meeting_attendees')
    .select('*, users!inner(id, name, email)')
    .eq('meeting_id', meetingId);
  return { ...meeting, attendees: attendees || [] };
}

/**
 * Send meeting invite emails to all pending attendees.
 */
async function sendMeetingInvites(meetingId) {
  const meeting = await loadMeetingWithAttendees(meetingId);
  if (!meeting) throw new Error('Meeting not found: ' + meetingId);

  const startFormatted = formatDateTime(meeting.start_time);
  const endFormatted = formatDateTime(
    new Date(new Date(meeting.start_time).getTime() + meeting.duration_minutes * 60000).toISOString()
  );
  const creatorName = meeting.users?.name || 'A team member';
  const safeTitle = escapeHtml(meeting.title);
  const safeDesc = escapeHtml(meeting.description);
  const safeLoc = escapeHtml(meeting.location);
  const safeLink = escapeHtml(meeting.meeting_link);

  let results = [];
  for (const attendee of meeting.attendees) {
    const rsvpLink = `${BASE}/meetings/rsvp?token=${attendee.rsvp_token}&response=accept`;
    const declineLink = `${BASE}/meetings/rsvp?token=${attendee.rsvp_token}&response=decline`;
    const maybeLink = `${BASE}/meetings/rsvp?token=${attendee.rsvp_token}&response=maybe`;

    const subject = `📅 Meeting: ${safeTitle} — ${startFormatted}`;
    const bodyHtml = `
      <div style="max-width:600px;margin:0 auto;font-family:Inter,sans-serif">
      <div style="background:#fff;border:1px solid #e0e0e0;padding:24px 32px;border-radius:8px">
        <p style="font-size:12px;color:#888;margin:0 0 12px;text-transform:uppercase;letter-spacing:.08em">Meeting Invitation</p>
        <p style="font-size:15px;color:#333">Hi ${escapeHtml(attendee.users.name)},</p>
        <p style="font-size:14px;color:#555">${escapeHtml(creatorName)} invited you to a meeting:</p>

        <div style="background:#f8f8f8;border-radius:8px;padding:16px;margin:16px 0">
          <p style="font-size:18px;font-weight:600;color:#1a1a1a;margin:0 0 8px">${safeTitle}</p>
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <tr><td style="color:#888;padding:4px 8px;width:80px">When</td>
                <td style="color:#333;padding:4px 8px;font-weight:500">${startFormatted} — ${endFormatted}</td></tr>
            ${safeLoc ? `<tr><td style="color:#888;padding:4px 8px">Where</td>
                <td style="color:#333;padding:4px 8px">${safeLoc}</td></tr>` : ''}
            ${safeLink ? `<tr><td style="color:#888;padding:4px 8px">Online</td>
                <td style="color:#333;padding:4px 8px"><a href="${safeLink}" style="color:#c0202b">${safeLink}</a></td></tr>` : ''}
            ${meeting.duration_minutes ? `<tr><td style="color:#888;padding:4px 8px">Duration</td>
                <td style="color:#333;padding:4px 8px">${meeting.duration_minutes} min</td></tr>` : ''}
          </table>
        </div>

        ${safeDesc ? `<div style="background:#f8f8f8;border-radius:8px;padding:16px;margin:16px 0">
          <p style="font-size:12px;color:#888;margin:0 0 6px;text-transform:uppercase;letter-spacing:.06em">Description</p>
          <p style="font-size:14px;color:#333;margin:0;line-height:1.5;white-space:pre-line">${safeDesc}</p>
        </div>` : ''}

        <p style="font-size:13px;color:#555;text-align:center;margin:20px 0 12px">Will you attend?</p>
        <table style="width:100%;border-collapse:collapse;margin:0 auto;max-width:360px">
          <tr>
            <td style="text-align:center;padding:4px">
              <a href="${rsvpLink}" style="display:inline-block;background:#10b981;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600;min-width:80px">✅ Accept</a>
            </td>
            <td style="text-align:center;padding:4px">
              <a href="${maybeLink}" style="display:inline-block;background:#f59e0b;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600;min-width:80px">❓ Maybe</a>
            </td>
            <td style="text-align:center;padding:4px">
              <a href="${declineLink}" style="display:inline-block;background:#ef4444;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600;min-width:80px">❌ Decline</a>
            </td>
          </tr>
        </table>

        <p style="font-size:12px;color:#aaa;text-align:center;margin:16px 0 0">
          <a href="${BASE}" style="color:#c0202b;text-decoration:none">FORGE by Recon Enterprises</a>
        </p>
      </div>
      </div>`;

    try {
      const info = await emailService.sendEmail({
        to: attendee.users.email,
        subject,
        htmlBody: bodyHtml,
      });
      results.push({ email: attendee.users.email, messageId: info.messageId, status: 'sent' });
    } catch (err) {
      console.warn('[meetings] invite failed for', attendee.users.email, err.message);
      results.push({ email: attendee.users.email, status: 'error', error: err.message });
    }
  }
  return results;
}

/**
 * Send a reminder for a specific meeting (to attendees who haven't responded, or all).
 */
async function sendReminderForMeeting(meetingId) {
  const meeting = await loadMeetingWithAttendees(meetingId);
  if (!meeting) throw new Error('Meeting not found: ' + meetingId);

  const startFormatted = formatDateTime(meeting.start_time);
  const safeTitle = escapeHtml(meeting.title);
  let sentCount = 0;

  for (const attendee of meeting.attendees) {
    const rsvpLink = `${BASE}/meetings/rsvp?token=${attendee.rsvp_token}&response=accept`;
    const declineLink = `${BASE}/meetings/rsvp?token=${attendee.rsvp_token}&response=decline`;
    const maybeLink = `${BASE}/meetings/rsvp?token=${attendee.rsvp_token}&response=maybe`;

    const subject = `⏰ Reminder: ${safeTitle} — ${startFormatted}`;
    const bodyHtml = `
      <div style="max-width:600px;margin:0 auto;font-family:Inter,sans-serif">
      <div style="background:#fff;border:1px solid #e0e0e0;padding:24px 32px;border-radius:8px">
        <p style="font-size:12px;color:#888;margin:0 0 12px;text-transform:uppercase;letter-spacing:.08em">Meeting Reminder</p>
        <p style="font-size:15px;color:#333">Hi ${escapeHtml(attendee.users.name)},</p>
        <p style="font-size:14px;color:#555">This is a reminder for the upcoming meeting:</p>

        <div style="background:#fff8e1;border:1px solid #f0c000;border-radius:8px;padding:16px;margin:16px 0">
          <p style="font-size:18px;font-weight:600;color:#1a1a1a;margin:0">${safeTitle}</p>
          <p style="font-size:13px;color:#666;margin:8px 0 0">${startFormatted}</p>
        </div>

        <p style="font-size:13px;color:#555;text-align:center;margin:16px 0 12px">Please confirm your attendance:</p>
        <table style="width:100%;border-collapse:collapse;margin:0 auto;max-width:360px">
          <tr>
            <td style="text-align:center;padding:4px">
              <a href="${rsvpLink}" style="display:inline-block;background:#10b981;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">✅ Accept</a>
            </td>
            <td style="text-align:center;padding:4px">
              <a href="${maybeLink}" style="display:inline-block;background:#f59e0b;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">❓ Maybe</a>
            </td>
            <td style="text-align:center;padding:4px">
              <a href="${declineLink}" style="display:inline-block;background:#ef4444;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">❌ Decline</a>
            </td>
          </tr>
        </table>
      </div>
      </div>`;

    try {
      await emailService.sendEmail({
        to: attendee.users.email,
        subject,
        htmlBody: bodyHtml,
      });
      sentCount++;
    } catch (err) {
      console.warn('[meetings] reminder failed for', attendee.users.email, err.message);
    }
  }

  // Mark reminder as sent
  await supabase.from('project_meetings').update({ reminder_sent_at: new Date().toISOString() }).eq('id', meetingId);
  return sentCount;
}

module.exports = { sendMeetingInvites, sendReminderForMeeting };
