import { op, jsonBody, idParam } from '../helpers.js';

export function homeInventoryPaths() {
  return {
    '/api/v1/home-inventory': {
      get: op({ summary: 'List home inventory items (daily household goods, separate from kitchen pantry)', tag: 'HomeInventory' }),
      post: op({ summary: 'Create home inventory item', tag: 'HomeInventory', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/home-inventory/taxonomy': {
      get: op({ summary: 'List fixed categories/units/locations plus custom entries of the home inventory module', tag: 'HomeInventory' }),
    },
    '/api/v1/home-inventory/categories': {
      post: op({ summary: 'Create a custom category (name is also the stored value)', tag: 'HomeInventory', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/home-inventory/categories/{optionId}': {
      put: op({ summary: 'Rename a custom category (items referencing it are updated)', tag: 'HomeInventory', params: [idParam('optionId', 'Category ID')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete a custom category (only while unused)', tag: 'HomeInventory', params: [idParam('optionId', 'Category ID')], stateChanging: true }),
    },
    '/api/v1/home-inventory/units': {
      post: op({ summary: 'Create a custom unit (name is also the stored value)', tag: 'HomeInventory', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/home-inventory/units/{optionId}': {
      put: op({ summary: 'Rename a custom unit (items referencing it are updated)', tag: 'HomeInventory', params: [idParam('optionId', 'Unit ID')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete a custom unit (only while unused)', tag: 'HomeInventory', params: [idParam('optionId', 'Unit ID')], stateChanging: true }),
    },
    '/api/v1/home-inventory/locations': {
      post: op({ summary: 'Create a custom storage location (name is also the stored value)', tag: 'HomeInventory', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/home-inventory/locations/{optionId}': {
      put: op({ summary: 'Rename a custom storage location (items referencing it are updated)', tag: 'HomeInventory', params: [idParam('optionId', 'Location ID')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete a custom storage location (only while unused)', tag: 'HomeInventory', params: [idParam('optionId', 'Location ID')], stateChanging: true }),
    },
    '/api/v1/home-inventory/{itemId}': {
      put: op({ summary: 'Replace home inventory item', tag: 'HomeInventory', params: [idParam('itemId', 'Item ID')], stateChanging: true, requestBody: jsonBody(null) }),
      patch: op({ summary: 'Partially update home inventory item (quantity stepper)', tag: 'HomeInventory', params: [idParam('itemId', 'Item ID')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete home inventory item', tag: 'HomeInventory', params: [idParam('itemId', 'Item ID')], stateChanging: true }),
    },
  };
}
