/* ============================================================
   ERP roles / module-group map.
   Same 9 roles the ERP front end (public/index.html, public/premier-erp.html)
   already renders in its login + user-admin screens — kept identical so no
   frontend change is needed here.
   ============================================================ */
'use strict';

const GROUPS_ALL = ['Home', 'CRM', 'Sales & AR', 'Inventory', 'Procurement', 'Fixed Assets', 'Human Resources', 'Compliance', 'Accounting', 'Inspection'];

const ROLES = {
  'Administrator':     '*',
  'Management':        GROUPS_ALL,
  'Accounts':          ['Home', 'CRM', 'Sales & AR', 'Procurement', 'Accounting'],
  'HR Officer':        ['Home', 'Human Resources'],
  'Inspector':         ['Home', 'Inspection', 'Compliance'],
  'QHSE / Quality':    ['Home', 'Compliance', 'Inspection'],
  'Sales / CRM':       ['Home', 'CRM', 'Sales & AR'],
  'Store / Logistics': ['Home', 'Inventory', 'Procurement'],
  'Viewer':            ['Home'],
};

// A role is either one of the 9 named presets above (kept for backward
// compatibility with employees already granted one of these), OR — since
// the Employees form now lets an admin multi-select modules directly
// instead of picking a named preset — a comma-separated list of module
// group names stored straight in erp_employee_roles.role, e.g.
// "CRM,Human Resources,Inspection". 'Home' is implied either way.
function moduleListFor(role) {
  const preset = ROLES[role];
  if (preset) return preset;
  if (!role) return null;
  return ['Home', ...String(role).split(',').map((s) => s.trim()).filter(Boolean)];
}
function canAccess(role, group) {
  const g = moduleListFor(role);
  if (!g) return false;
  if (g === '*') return true;
  return !group || g.includes(group);
}

module.exports = { GROUPS_ALL, ROLES, canAccess, moduleListFor };
