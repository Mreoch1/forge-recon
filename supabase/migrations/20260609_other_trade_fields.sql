-- D-174: Custom "other" trade name and description on the intake form
ALTER TABLE contractor_vendor_intakes ADD COLUMN IF NOT EXISTS other_trade_name TEXT;
ALTER TABLE contractor_vendor_intakes ADD COLUMN IF NOT EXISTS other_trade_description TEXT;
