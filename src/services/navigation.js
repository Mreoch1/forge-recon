function cleanPart(value) {
  return String(value || '').trim();
}

function locationText(record = {}) {
  const cityState = [cleanPart(record.city), cleanPart(record.state)].filter(Boolean).join(', ');
  return [cleanPart(record.address), cityState].filter(Boolean).join(', ');
}

function addUniquePickerLabels(records, buildLabel) {
  const rows = Array.isArray(records) ? records : [];
  const candidates = rows.map((record) => buildLabel(record) || `Record #${record.id}`);
  const counts = candidates.reduce((map, label) => {
    map.set(label, (map.get(label) || 0) + 1);
    return map;
  }, new Map());

  return rows.map((record, index) => ({
    ...record,
    picker_label: counts.get(candidates[index]) > 1
      ? `${candidates[index]} (#${record.id})`
      : candidates[index],
  }));
}

function decorateCustomerPickerOptions(customers) {
  return addUniquePickerLabels(customers, (customer) => {
    const name = cleanPart(customer.name) || `Customer #${customer.id}`;
    const location = locationText(customer);
    return location ? `${name} - ${location}` : name;
  });
}

function decorateProjectPickerOptions(projects) {
  return addUniquePickerLabels(projects, (project) => {
    const title = cleanPart(project.title) || `Project #${project.id}`;
    const context = [cleanPart(project.customer_name), locationText(project)].filter(Boolean).join(' - ');
    return context ? `${title} - ${context}` : title;
  });
}

function getBackButtonState(pathname) {
  const path = cleanPart(pathname).split('?')[0] || '/';
  if (path === '/') return { show: false, fallback: '/' };

  let match = path.match(/^\/files\/projects\/(\d+)/);
  if (match) return { show: true, fallback: `/projects/${match[1]}` };

  match = path.match(/^\/files\/work_order\/(\d+)/);
  if (match) return { show: true, fallback: `/work-orders/${match[1]}` };

  match = path.match(/^\/files\/(customers|vendors|contractors)\/(\d+)/);
  if (match) return { show: true, fallback: `/${match[1]}/${match[2]}` };

  if (/^\/files\/workers(?:\/\d+)?/.test(path)) {
    return { show: true, fallback: '/files/workers' };
  }

  match = path.match(/^\/(work-orders|customers|vendors|contractors|projects|estimates|invoices|bills)\/(\d+)(?:\/.+)?$/);
  if (match) {
    const detailPath = `/${match[1]}/${match[2]}`;
    return {
      show: true,
      fallback: path === detailPath ? `/${match[1]}` : detailPath,
    };
  }

  const firstSegment = path.split('/').filter(Boolean)[0];
  const knownRoots = new Set([
    'accounting', 'admin', 'companies', 'contractors', 'customers', 'estimates',
    'files', 'invoices', 'meetings', 'projects', 'schedule', 'settings',
    'universal-documents', 'vendor-intake', 'vendors', 'work-orders',
  ]);
  const fallback = firstSegment && knownRoots.has(firstSegment) && path !== `/${firstSegment}`
    ? `/${firstSegment}`
    : '/';

  return { show: true, fallback };
}

module.exports = {
  decorateCustomerPickerOptions,
  decorateProjectPickerOptions,
  getBackButtonState,
};
