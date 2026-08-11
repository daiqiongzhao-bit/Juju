import { op, jsonBody, idParam } from '../helpers.js';

export function shoppingPaths() {
  return {
    '/api/v1/shopping': {
      get: op({ summary: 'List shopping lists', tag: 'Shopping' }),
      post: op({ summary: 'Create shopping list', tag: 'Shopping', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/shopping/categories': {
      get: op({ summary: 'List shopping categories', tag: 'Shopping' }),
      post: op({ summary: 'Create shopping category', tag: 'Shopping', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/shopping/categories/{catId}': {
      put: op({ summary: 'Update shopping category', tag: 'Shopping', params: [idParam('catId', 'Category ID')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete shopping category', tag: 'Shopping', params: [idParam('catId', 'Category ID')], stateChanging: true }),
    },
    '/api/v1/shopping/categories/reorder': {
      patch: op({ summary: 'Reorder shopping categories', tag: 'Shopping', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/shopping/suggestions': { get: op({ summary: 'Get shopping suggestions', tag: 'Shopping' }) },
    '/api/v1/shopping/items/undo-transfer': {
      post: op({
        summary: 'Undo a kitchen transfer to a shopping list',
        description: 'Removes the items created by one transfer (the `added_ids` of the response) and clears the `on_shopping_list` flag on the meal ingredients they came from. Unknown ids are skipped; `removed` reports what actually went back.',
        tag: 'Shopping',
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/shopping/items/{itemId}': {
      patch: op({ summary: 'Update shopping item', tag: 'Shopping', params: [idParam('itemId', 'Item ID')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete shopping item', tag: 'Shopping', params: [idParam('itemId', 'Item ID')], stateChanging: true }),
    },
    '/api/v1/shopping/{listId}': {
      put: op({ summary: 'Rename shopping list', tag: 'Shopping', params: [idParam('listId', 'List ID')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete shopping list', tag: 'Shopping', params: [idParam('listId', 'List ID')], stateChanging: true }),
    },
    '/api/v1/shopping/{listId}/items': {
      get: op({ summary: 'List items in shopping list', tag: 'Shopping', params: [idParam('listId', 'List ID')] }),
      post: op({ summary: 'Add item to shopping list', tag: 'Shopping', params: [idParam('listId', 'List ID')], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/shopping/{listId}/import-pantry': {
      post: op({
        summary: 'Add pantry items to a shopping list',
        description: 'Adds low or empty pantry items to the list. Names already on the list unchecked are skipped instead of duplicated.',
        tag: 'Shopping',
        params: [idParam('listId', 'List ID')],
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/shopping/{listId}/items/checked': {
      delete: op({ summary: 'Delete checked shopping items', tag: 'Shopping', params: [idParam('listId', 'List ID')], stateChanging: true }),
    },
  };
}
