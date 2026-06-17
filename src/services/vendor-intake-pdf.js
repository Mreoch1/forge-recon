const PDFDocument = require('pdfkit');

const RED = '#c81e2a';
const CHARCOAL = '#1f1f1f';
const FOG = '#777777';
const LINE = '#dddddd';

function display(value, fallback = '-') {
  if (value === undefined || value === null || value === '') return fallback;
  if (Array.isArray(value)) return value.length ? value.join(', ') : fallback;
  return String(value);
}

function boolText(value) {
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  return '-';
}

function money(value) {
  if (value === undefined || value === null || value === '') return '-';
  const n = Number(value);
  if (!Number.isFinite(n)) return display(value);
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function dateText(value) {
  if (!value) return '-';
  return String(value).slice(0, 10);
}

function addPageIfNeeded(doc, needed = 60) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed > bottom) doc.addPage();
}

function section(doc, title) {
  addPageIfNeeded(doc, 70);
  doc.moveDown(0.7);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(RED).text(title.toUpperCase());
  doc.moveTo(doc.page.margins.left, doc.y + 4)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y + 4)
    .strokeColor(LINE)
    .lineWidth(1)
    .stroke();
  doc.moveDown(0.8);
}

function field(doc, label, value) {
  addPageIfNeeded(doc, 42);
  doc.font('Helvetica-Bold').fontSize(7).fillColor(FOG).text(label.toUpperCase(), { continued: false });
  doc.font('Helvetica').fontSize(9).fillColor(CHARCOAL).text(display(value), {
    width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
  });
  doc.moveDown(0.45);
}

function twoColumnFields(doc, rows) {
  const leftX = doc.page.margins.left;
  const rightX = 315;
  const colWidth = 230;

  rows.forEach(([left, right]) => {
    addPageIfNeeded(doc, 48);
    const startY = doc.y;

    doc.x = leftX;
    doc.y = startY;
    doc.font('Helvetica-Bold').fontSize(7).fillColor(FOG).text(left[0].toUpperCase(), { width: colWidth });
    doc.font('Helvetica').fontSize(9).fillColor(CHARCOAL).text(display(left[1]), { width: colWidth });
    const leftBottom = doc.y;

    if (right) {
      doc.x = rightX;
      doc.y = startY;
      doc.font('Helvetica-Bold').fontSize(7).fillColor(FOG).text(right[0].toUpperCase(), { width: colWidth });
      doc.font('Helvetica').fontSize(9).fillColor(CHARCOAL).text(display(right[1]), { width: colWidth });
    }

    doc.x = leftX;
    doc.y = Math.max(leftBottom, doc.y) + 8;
  });
}

function noteUser(note) {
  if (!note || !note.users) return 'FORGE';
  return note.users.name || note.users.email || 'FORGE';
}

function generateVendorIntakePDF(intake, notes, stream) {
  const doc = new PDFDocument({
    size: 'LETTER',
    margin: 50,
    info: {
      Title: `${display(intake.company_name, 'Trade intake')} - Trade Intake`,
      Author: 'FORGE',
    },
  });

  doc.pipe(stream);

  doc.font('Helvetica-Bold').fontSize(9).fillColor(FOG).text('RECON ENTERPRISES INC.');
  doc.fontSize(22).fillColor(RED).text('FORGE');
  doc.moveDown(1.2);

  doc.font('Helvetica-Bold').fontSize(24).fillColor(CHARCOAL).text('Trade Intake');
  doc.font('Helvetica-Bold').fontSize(13).fillColor(RED).text(display(intake.company_name, '(unnamed company)'));
  doc.font('Helvetica').fontSize(9).fillColor(FOG)
    .text(`${display(intake.trades, 'No trades entered')} | ${display([intake.city, intake.state].filter(Boolean).join(', '), 'No location')}`);
  doc.moveDown(0.6);
  doc.fontSize(8).fillColor(FOG).text(`Generated ${new Date().toISOString().slice(0, 10)}`);

  section(doc, 'Summary');
  twoColumnFields(doc, [
    [['Type', intake.company_type], ['Status', intake.status]],
    [['Rating', intake.rating ? `${intake.rating} / 5` : '-'], ['Submitted', dateText(intake.submitted_at)]],
    [['Public update due', dateText(intake.next_update_due_at)], ['Last updated', dateText(intake.updated_at)]],
  ]);

  section(doc, 'Company Information');
  twoColumnFields(doc, [
    [['Legal company name', intake.company_name], ['DBA / short name', intake.dba_name]],
    [['Company email', intake.email], ['Website', intake.website]],
    [['Office phone', intake.office_phone], ['Mobile phone', intake.mobile_phone]],
    [['Address', [intake.address, intake.city, intake.state, intake.zip].filter(Boolean).join(', ')], ['Service area', intake.service_area]],
    [['Primary contact', [intake.primary_contact_name, intake.primary_contact_title, intake.primary_contact_email, intake.primary_contact_phone].filter(Boolean).join('\n')], ['Billing contact', [intake.billing_contact_name, intake.billing_contact_email, intake.billing_contact_phone].filter(Boolean).join('\n')]],
  ]);
  if (intake.other_trade_name || intake.other_trade_description) {
    field(doc, 'Other trade / service', [intake.other_trade_name, intake.other_trade_description].filter(Boolean).join('\n'));
  }

  section(doc, 'Experience');
  twoColumnFields(doc, [
    [['Years in business', intake.years_in_business], ['Employees', intake.employee_count]],
    [['Field staff', intake.field_staff_count], ['Annual capacity', intake.annual_capacity]],
    [['Largest project value', money(intake.largest_project_value)], ['Largest project date', intake.largest_project_date]],
    [['Largest project name', intake.largest_project_name], ['Largest project location', intake.largest_project_location]],
  ]);
  field(doc, 'Largest project description', intake.largest_project_description);
  field(doc, 'Occupied multifamily experience', `${boolText(intake.occupied_multifamily)}${intake.occupied_multifamily_notes ? `\n${intake.occupied_multifamily_notes}` : ''}`);

  section(doc, 'Insurance & Compliance');
  twoColumnFields(doc, [
    [['General liability', boolText(intake.insurance_gl)], ['Workers comp', boolText(intake.insurance_workers_comp)]],
    [['Auto insurance', boolText(intake.insurance_auto)], ['Insurance expiration', dateText(intake.insurance_expiration_date)]],
    [['Union status', display(intake.union_status).replace('_', ' ')], ['Bondable', boolText(intake.bondable)]],
    [['Prevailing wage', boolText(intake.prevailing_wage_experience)], ['HUD/MSHDA', boolText(intake.hud_mshda_experience)]],
    [['Section 3', boolText(intake.section3_business)], ['License numbers', intake.license_numbers]],
  ]);
  field(doc, 'HUD/MSHDA notes', intake.hud_mshda_notes);
  field(doc, 'Section 3 notes', intake.section3_notes);
  field(doc, 'Certifications', intake.certifications);
  field(doc, 'Safety notes', intake.safety_notes);
  field(doc, 'Documents available', intake.documents_notes);

  section(doc, 'Bid Participation Acknowledgment');
  field(doc, 'Project information confidentiality', 'By submitting this form, I acknowledge that any project opportunity, bid package, scope of work, drawings, specifications, walkthrough information, schedule, GC contact, owner contact, pricing request, or related project information provided by Recon Enterprises Inc. is confidential and is provided only for the purpose of bidding or performing work through Recon Enterprises Inc.');
  twoColumnFields(doc, [
    [['Non-circumvention', boolText(intake.bid_non_circumvention_acknowledged)], ['Direct contact routing', boolText(intake.bid_direct_contact_acknowledged)]],
    [['Future agreement', boolText(intake.bid_future_agreement_acknowledged)], ['Acknowledged at', dateText(intake.bid_participation_acknowledged_at || intake.submitted_at)]],
  ]);
  field(doc, 'Non-circumvention terms', 'I agree not to bypass Recon Enterprises Inc., submit direct pricing, or accept direct award for the same project or scope from any owner, GC, construction manager, property manager, or project contact introduced through Recon without prior written approval.');
  field(doc, 'Direct contact terms', 'If contacted directly regarding a Recon-introduced project, I agree to notify Recon and route all pricing, revisions, questions, and project communication back through Recon.');
  field(doc, 'Future agreement terms', 'I understand that Recon may require a signed Subcontractor Bid Participation and Non-Circumvention Agreement before releasing future bid packages, drawings, scopes, or project details.');

  section(doc, 'References');
  const refs = Array.isArray(intake.references_json) ? intake.references_json : [];
  if (!refs.length) {
    field(doc, 'References', 'No references entered.');
  } else {
    refs.forEach((ref, index) => {
      field(doc, `Reference ${index + 1}`, [
        ref.name,
        ref.company,
        [ref.email, ref.phone].filter(Boolean).join(' | '),
        ref.relationship,
        ref.notes,
      ].filter(Boolean).join('\n'));
    });
  }

  section(doc, 'Internal Review');
  twoColumnFields(doc, [
    [['Status', intake.status], ['Rating', intake.rating ? `${intake.rating} / 5` : '-']],
    [['Promoted vendor id', intake.promoted_vendor_id], ['Promoted contractor id', intake.promoted_contractor_id]],
  ]);
  field(doc, 'Internal notes', intake.internal_notes);

  section(doc, 'Follow-up Notes');
  const noteRows = notes || [];
  if (!noteRows.length) {
    field(doc, 'Notes', 'No follow-up notes.');
  } else {
    noteRows.forEach((note) => {
      field(doc, `${display(note.note_type, 'note')} - ${dateText(note.created_at)} - ${noteUser(note)}`, note.body);
    });
  }

  doc.end();
}

module.exports = { generateVendorIntakePDF };
