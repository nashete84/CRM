/**
 * Salesforce Enterprise Edition limits, from its published "Custom Field
 * Allocations" and "Custom Object Limits" (DECISIONS.md D-026).
 */
export const LIMITS = {
  customObjectsPerOrg: 200,
  customFieldsPerObject: 500,
  relationshipFieldsPerObject: 40,
  masterDetailPerObject: 2,
  /** Levels in a chain of master-detail relationships, counting the top master. */
  masterDetailDepth: 3,
  externalIdsPerObject: 25,
  picklistValuesPerField: 1000,
} as const;
