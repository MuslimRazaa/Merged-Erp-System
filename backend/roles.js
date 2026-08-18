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

function canAccess(role, group) {
  const g = ROLES[role];
  if (!g) return false;
  if (g === '*') return true;
  return !group || g.includes(group);
}

module.exports = { GROUPS_ALL, ROLES, canAccess };
