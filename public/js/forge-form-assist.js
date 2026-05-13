/* eslint-env browser */
(function () {
  'use strict';

  const path = window.location.pathname;
  const form = document.querySelector('main form[action]:not(.recon-aic-input):not(.recon-aic-report):not(.m-0):not(.p-0)');
  const root = document.getElementById('ai-chat-root');
  if (!form || !root) return;
  if (path === '/' || path.startsWith('/admin') || path.startsWith('/settings')) return;
  if (String(form.method || '').toLowerCase() !== 'post') return;

  const contexts = [
    {
      test: /^\/work-orders\/new\/?$/.test(path),
      eyebrow: 'Work order intake',
      title: 'Let FORGE build the work order',
      body: 'Describe the call, email, or field request in plain language. FORGE will ask for the missing pieces and prepare a confirmation before anything is saved.',
      message: 'Help me create a work order. Ask me for the customer, unit, schedule, crew, and job details, then prepare a safe confirmation instead of making me type the form.',
    },
    {
      test: /^\/customers\/new\/?$/.test(path),
      eyebrow: 'Customer intake',
      title: 'Tell FORGE about the customer',
      body: 'Paste a signature, email, or quick note. FORGE can pull out the name, contact details, billing email, address, and notes.',
      message: 'Help me create a customer from a note, email signature, or rough description. Ask for any missing contact or billing details before saving.',
    },
    {
      test: /^\/projects\/new\/?$/.test(path),
      eyebrow: 'Project setup',
      title: 'Let FORGE start the project',
      body: 'Give FORGE the customer, site, scope, and rough status. It can turn that into a project draft you review.',
      message: 'Help me create a project. Ask for customer, site, scope, status, and any missing setup details before saving.',
    },
    {
      test: /^\/vendors\/new\/?$/.test(path),
      eyebrow: 'Vendor intake',
      title: 'Let FORGE capture the vendor',
      body: 'Drop in a vendor name, invoice, email, or contact card and let FORGE collect the structured details.',
      message: 'Help me create a vendor from rough notes or an invoice. Ask for missing contact, payment, and trade details before saving.',
    },
    {
      test: /^\/bills\/new\/?$/.test(path),
      eyebrow: 'Bill entry',
      title: 'Give the bill to FORGE',
      body: 'Tell FORGE the vendor, amount, due date, job, and line details. It will organize the bill before you approve it.',
      message: 'Help me enter a bill. Ask for vendor, amount, due date, job or work order, and line item details before saving.',
    },
    {
      test: /^\/estimates\/[^/]+\/edit\/?$/.test(path) || /^\/estimates\/new\/?$/.test(path),
      eyebrow: 'Estimate drafting',
      title: 'Have FORGE draft the estimate',
      body: 'Describe the scope and pricing. FORGE can shape line items, quantities, notes, tax, and terms for review.',
      message: 'Help me draft this estimate. Ask for scope, line items, quantities, units, pricing, notes, tax, and terms before saving.',
    },
    {
      test: /^\/invoices\/[^/]+\/edit\/?$/.test(path),
      eyebrow: 'Invoice cleanup',
      title: 'Let FORGE prepare the invoice',
      body: 'Give FORGE the billing change or customer note. It can organize line items, terms, due date, and customer-facing notes.',
      message: 'Help me prepare this invoice. Ask for line items, due date, terms, notes, and any missing billing details before saving.',
    },
  ];

  const matchedContext = contexts.find(item => item.test);
  if (!matchedContext && !/(\/new|\/edit)\/?$/.test(path)) return;

  const context = matchedContext || {
    eyebrow: 'FORGE-first entry',
    title: 'Tell FORGE what you need',
    body: 'Use plain language first. FORGE can gather details, ask follow-up questions, and prepare a reviewed action before manual data entry.',
    message: 'Help me complete this screen. Ask what I am trying to do, gather the missing details, and prepare the safest next step before I type into the form.',
  };

  const panel = document.createElement('section');
  panel.className = 'forge-form-assist';
  panel.innerHTML = `
    <div>
      <div class="forge-form-assist-eyebrow">${escapeHTML(context.eyebrow)}</div>
      <h2>${escapeHTML(context.title)}</h2>
      <p>${escapeHTML(context.body)}</p>
    </div>
    <button type="button" class="forge-form-assist-btn">Use FORGE</button>
  `;

  const style = document.createElement('style');
  style.textContent = `
    .forge-form-assist {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 1rem;
      align-items: center;
      margin: 0 0 1rem;
      padding: 1rem;
      border: 1px solid #1a1a1a;
      border-radius: 6px;
      background: #fff;
      box-shadow: 0 1px 3px rgba(0,0,0,.06);
    }
    .forge-form-assist-eyebrow {
      font-size: .68rem;
      line-height: 1;
      font-weight: 800;
      letter-spacing: .14em;
      text-transform: uppercase;
      color: #c0202b;
      margin-bottom: .35rem;
    }
    .forge-form-assist h2 {
      margin: 0;
      font-size: 1rem;
      font-weight: 800;
      color: #1a1a1a;
      letter-spacing: 0;
    }
    .forge-form-assist p {
      margin: .3rem 0 0;
      max-width: 48rem;
      color: #666;
      font-size: .86rem;
      line-height: 1.45;
    }
    .forge-form-assist-btn {
      border: 0;
      border-radius: 4px;
      background: #c0202b;
      color: #fff;
      font-weight: 800;
      font-size: .86rem;
      padding: .65rem 1rem;
      min-height: 42px;
      cursor: pointer;
      white-space: nowrap;
    }
    .forge-form-assist-btn:hover { background: #8a0e16; }
    @media (max-width: 640px) {
      .forge-form-assist { grid-template-columns: 1fr; }
      .forge-form-assist-btn { width: 100%; }
    }
  `;
  document.head.appendChild(style);

  const target = form.closest('.card') || form;
  target.parentNode.insertBefore(panel, target);

  panel.querySelector('button').addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('forge:assistant', {
      detail: { message: context.message },
    }));
  });

  function escapeHTML(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
})();
