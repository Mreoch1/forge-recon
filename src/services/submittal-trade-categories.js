const SUBMITTAL_TRADE_CATEGORIES = [
  'General / Other',
  'Sitework & Landscaping',
  'Concrete & Masonry',
  'Metals',
  'Carpentry & Millwork',
  'Cabinets',
  'Countertops',
  'Insulation',
  'Roofing & Waterproofing',
  'Doors, Frames & Hardware',
  'Glass & Glazing',
  'Drywall & Gypsum',
  'Tile',
  'Flooring',
  'Paint & Coatings',
  'Adhesives & Sealants',
  'Specialties',
  'Equipment & Appliances',
  'Furnishings',
  'Fire Protection',
  'Plumbing',
  'HVAC',
  'Electrical',
  'Low Voltage & Life Safety',
];

const categoryByLowercase = new Map(
  SUBMITTAL_TRADE_CATEGORIES.map(category => [category.toLowerCase(), category]),
);

const CSI_DIVISION_CATEGORIES = new Map([
  ['01', 'General / Other'],
  ['02', 'Sitework & Landscaping'],
  ['03', 'Concrete & Masonry'],
  ['04', 'Concrete & Masonry'],
  ['05', 'Metals'],
  ['06', 'Carpentry & Millwork'],
  ['07', 'Roofing & Waterproofing'],
  ['08', 'Doors, Frames & Hardware'],
  ['10', 'Specialties'],
  ['11', 'Equipment & Appliances'],
  ['12', 'Furnishings'],
  ['21', 'Fire Protection'],
  ['22', 'Plumbing'],
  ['23', 'HVAC'],
  ['26', 'Electrical'],
  ['27', 'Low Voltage & Life Safety'],
  ['28', 'Low Voltage & Life Safety'],
  ['31', 'Sitework & Landscaping'],
  ['32', 'Sitework & Landscaping'],
  ['33', 'Sitework & Landscaping'],
]);

const KEYWORD_CATEGORIES = [
  ['Low Voltage & Life Safety', /\b(low voltage|data cabling|access control|security|fire alarm|smoke detector|life safety)\b/i],
  ['Electrical', /\b(electrical|lighting|light fixture|luminaire|lamp|vanity light|receptacle|switch|panelboard|circuit breaker)\b/i],
  ['Countertops', /\b(countertops?|counter tops?|solid surface|quartz|granite)\b/i],
  ['Cabinets', /\b(cabinets?|casework|vanit(?:y|ies))\b/i],
  ['Tile', /\b(ceramic|porcelain|tile|grout)\b/i],
  ['Flooring', /\b(flooring|floor covering|carpet|broadloom|lvt|luxury vinyl|vinyl plank|rubber base|resilient)\b/i],
  ['Paint & Coatings', /\b(paint|primer|promar|coating|epoxy coating|stain|enamel)\b/i],
  ['Adhesives & Sealants', /\b(adhesive|sealant|caulk|mastic|construction glue)\b/i],
  ['Plumbing', /\b(plumbing|faucet|lavatory|sink|toilet|water closet|shower|tub|valve|water heater|drain)\b/i],
  ['HVAC', /\b(hvac|air condition|furnace|heat pump|thermostat|air handler|diffuser|damper|ventilation)\b/i],
  ['Fire Protection', /\b(sprinkler|fire suppression|standpipe|fire extinguisher)\b/i],
  ['Doors, Frames & Hardware', /\b(door|frame|door hardware|lever set|lockset|hinge|closer)\b/i],
  ['Glass & Glazing', /\b(glass|glazing|mirror|storefront|window)\b/i],
  ['Drywall & Gypsum', /\b(drywall|gypsum|sheetrock|joint compound)\b/i],
  ['Insulation', /\b(insulation|mineral wool|fiberglass batt|foam board)\b/i],
  ['Roofing & Waterproofing', /\b(roof|roofing|waterproof|flashing|weather barrier|vapor barrier)\b/i],
  ['Carpentry & Millwork', /\b(carpentry|millwork|wood trim|molding|lumber)\b/i],
  ['Equipment & Appliances', /\b(appliance|range hood|refrigerator|dishwasher|range|oven|microwave|washer|dryer)\b/i],
  ['Metals', /\b(structural steel|metal fabrication|handrail|guardrail|steel stud)\b/i],
  ['Concrete & Masonry', /\b(concrete|masonry|brick|block|mortar|cement)\b/i],
  ['Sitework & Landscaping', /\b(sitework|landscap|planting|irrigation|asphalt|paving|earthwork)\b/i],
  ['Specialties', /\b(toilet accessory|signage|locker|fireplace|postal specialt)\b/i],
  ['Furnishings', /\b(furnishing|window treatment|blind|shade|furniture)\b/i],
];

function canonicalTradeCategory(value) {
  const raw = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return categoryByLowercase.get(raw.toLowerCase()) || '';
}

function categoryFromCsi(value, context) {
  const division = String(value || '').trim().match(/^(\d{2})(?:\s|$)/)?.[1];
  if (division === '09') return categoryFromKeywords(context) || 'Drywall & Gypsum';
  return CSI_DIVISION_CATEGORIES.get(division) || '';
}

function categoryFromKeywords(value) {
  const source = String(value == null ? '' : value);
  return KEYWORD_CATEGORIES.find(([, pattern]) => pattern.test(source))?.[0] || '';
}

function classifySubmittalTrade(metadata = {}) {
  const supplied = String(metadata.section_number || '').trim();
  const canonical = canonicalTradeCategory(supplied);
  if (canonical) return canonical;

  const context = [
    metadata.title,
    metadata.product_name,
    metadata.model_number,
    metadata.notes,
    supplied,
  ].filter(Boolean).join(' | ');
  return categoryFromCsi(supplied, context)
    || categoryFromKeywords(context)
    || 'General / Other';
}

function normalizeStoredTradeCategory(metadata = {}) {
  const supplied = String(metadata.section_number || '').replace(/\s+/g, ' ').trim();
  if (!supplied) return '';
  const canonical = canonicalTradeCategory(supplied);
  if (canonical) return canonical;

  const context = [
    metadata.title,
    metadata.product_name,
    metadata.model_number,
    metadata.notes,
    supplied,
  ].filter(Boolean).join(' | ');
  return categoryFromCsi(supplied, context)
    || categoryFromKeywords(context)
    || supplied;
}

module.exports = {
  SUBMITTAL_TRADE_CATEGORIES,
  canonicalTradeCategory,
  classifySubmittalTrade,
  normalizeStoredTradeCategory,
};
