import { op, jsonBody, idParam } from '../helpers.js';

export function homeInventoryPaths() {
  return {
    '/api/v1/home-inventory': {
      get: op({ summary: 'List home inventory items (daily household goods, separate from kitchen pantry)', tag: 'HomeInventory' }),
      post: op({ summary: 'Create home inventory item', tag: 'HomeInventory', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/home-inventory/taxonomy': {
      get: op({ summary: 'List fixed categories and units of the home inventory module', tag: 'HomeInventory' }),
    },
    '/api/v1/home-inventory/{itemId}': {
      put: op({ summary: 'Replace home inventory item', tag: 'HomeInventory', params: [idParam('itemId', 'Item ID')], stateChanging: true, requestBody: jsonBody(null) }),
      patch: op({ summary: 'Partially update home inventory item (quantity stepper)', tag: 'HomeInventory', params: [idParam('itemId', 'Item ID')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete home inventory item', tag: 'HomeInventory', params: [idParam('itemId', 'Item ID')], stateChanging: true }),
    },
  };
}
