# FORGE User Guide

This guide is for office staff who use FORGE day-to-day. It covers the basics: logging in, managing customers, creating work orders, sending estimates, collecting payment, paying vendor bills, and reading the schedule.

## Logging in

FORGE lives at **https://forge-recon.vercel.app**. Open it in any modern browser, enter your email and password, and click **Sign in**. Email is case-insensitive.

If you don't have an account yet, contact your admin — they create users from the Admin panel. There are no default credentials.

If you forget your password, click **Forgot password** on the sign-in page. You'll get a reset link by email if your address is on file.

![placeholder: FORGE login page]

## Customers

The **Customers** page (under the **More** menu) lists everyone you do work for.

- **Create**: Click **+ New customer**, fill in name, contact info, billing email, and address, then save. The "email" field is used for estimates; "billing email" is used for invoices.
- **Find**: Use the search box at the top of the list. It matches name, email, phone, or city.
- **Edit**: Open a customer and click **Edit**. You cannot delete a customer who still has jobs attached.

## Work Orders (the main workflow)

A work order (WO) is the central record in FORGE. Every job follows the same pattern:

1. **Customer calls.** You pick up the phone.
2. **Find or create the customer** in FORGE.
3. **Open the customer's job** (or create one) and click **+ New work order**.
4. **Fill in the WO**: unit number / WO display number, scheduled date and time, who is assigned (pick from the active user list), notes, and line items (description, quantity, unit, price).
5. **Save.** FORGE assigns the next WO number automatically (you can override it). The worker can now open the WO from their account on any device.
6. **The worker does the work**, updates status to **In progress** when they start and **Complete** when they're done. They can attach photos and post notes from the same screen.

You can also create a WO from free-form text with **AI-assisted create** — paste the customer's request and FORGE will pre-fill the form for you to review.

A WO can have **sub-WOs** for follow-up work. Sub-WOs share the parent's main number and get sequential sub-numbers (for example, 0142-0001, 0142-0002).

![placeholder: WO show page with assignee chips, status badge, and line items]

## Estimates

From any WO, click **Create estimate**. FORGE copies the line items over and sets the estimate number to match the WO (prefixed `EST-`).

- Edit the estimate while it is **draft** — add tax rate, valid-until date, and notes.
- Click **Send** to email a PDF to the customer's primary email. The estimate becomes **Sent**.
- When the customer agrees, click **Accept**. If they decline, click **Reject**.
- From an accepted estimate, click **Generate invoice** to push it through to invoicing.

## Invoices

Each invoice is created from an accepted estimate and inherits the WO's display number (prefixed `INV-`).

- Set payment terms (Due on receipt, Net 15/30/45/60, or Custom) and a due date.
- Click **Send** to email a PDF to the customer's billing email (falls back to the primary email if blank).
- Click **Mark paid** when payment arrives. Partial payments are supported — the invoice stays in **Sent** until fully paid.
- Click **Void** to cancel an invoice. You cannot delete a sent invoice; void it instead.

## Bills (vendor side)

The **Bills** page (under **More**) tracks what you owe vendors.

- Click **+ New bill**, pick the vendor, enter the bill number, date, due date, optional job/WO link, and line items.
- **Save** as **Draft**.
- **Approve** when the bill is ready to pay. Approval posts the accounting entry (debit expense, credit accounts payable).
- **Pay** records the payment (full or partial). Full payment closes the bill; partial leaves it approved.
- **Void** cancels the bill. If it was already approved, FORGE posts a reversing entry.

## Schedule

The **Schedule** page shows scheduled and in-progress WOs by day. Switch between **Week**, **2-week**, and **Month** views with the buttons at the top.

- Each WO appears as a colored block. The color reflects status (blue = scheduled, orange = in progress, red = conflict or overdue).
- **Drag and drop** a WO to a different day or time to reschedule it. FORGE checks for assignee conflicts before saving and warns you if there's an overlap.
- Use the **Assignee** dropdown to filter by worker.
- **Shop closures and holidays** (set by your admin) show as shaded bands on the calendar.

## Photos and notes on a WO

On any WO show page:

- **Notes**: Type a message in the note box and click post. The note shows your name and timestamp. Workers can post notes on their own assigned WOs.
- **Photos**: Click **Upload photo(s)**. JPG, PNG, WEBP, and HEIC are accepted, up to 10 MB each and 6 photos per upload. Photos appear in the WO gallery with a thumbnail and caption.
