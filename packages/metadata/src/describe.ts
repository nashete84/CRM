import type { FieldType } from "./field-types.js";
import { type Ctx, type FieldRow, type ObjectMeta, loadObjectMeta } from "./model.js";
import { childRelationshipName, parentRelationshipName } from "./names.js";

/**
 * Salesforce describe shapes (a compatible subset of DescribeSObjectResult),
 * so tools written against Salesforce can read this org's schema (answer #7).
 */
export type PicklistEntry = {
  value: string;
  label: string;
  active: boolean;
  defaultValue: boolean;
};

export type FieldDescribe = {
  name: string;
  label: string;
  type: string;
  length: number;
  precision: number;
  scale: number;
  nillable: boolean;
  unique: boolean;
  caseSensitive: boolean;
  externalId: boolean;
  custom: boolean;
  nameField: boolean;
  autoNumber: boolean;
  calculated: boolean;
  createable: boolean;
  updateable: boolean;
  defaultedOnCreate: boolean;
  defaultValue: boolean | string | null;
  inlineHelpText: string | null;
  picklistValues: PicklistEntry[];
  restrictedPicklist: boolean;
  referenceTo: string[];
  relationshipName: string | null;
  relationshipOrder: number | null;
  cascadeDelete: boolean;
  restrictedDelete: boolean;
  extraTypeInfo: string | null;
};

export type ChildRelationship = {
  childSObject: string;
  field: string;
  relationshipName: string;
  cascadeDelete: boolean;
  restrictedDelete: boolean;
};

export type RecordTypeInfo = {
  recordTypeId: string;
  developerName: string;
  name: string;
  active: boolean;
  available: boolean;
  defaultRecordTypeMapping: boolean;
  master: boolean;
};

export type ObjectDescribe = {
  name: string;
  label: string;
  labelPlural: string;
  keyPrefix: string;
  custom: boolean;
  createable: boolean;
  updateable: boolean;
  deletable: boolean;
  sharingModel: string;
  fields: FieldDescribe[];
  childRelationships: ChildRelationship[];
  recordTypeInfos: RecordTypeInfo[];
};

export type GlobalDescribeEntry = {
  name: string;
  label: string;
  labelPlural: string;
  keyPrefix: string;
  custom: boolean;
};

/** Salesforce's fixed ID for the Master record type. */
export const MASTER_RECORD_TYPE_ID = "012000000000000AAA";

const SOAP_TYPE: Record<FieldType, string> = {
  Text: "string",
  TextArea: "textarea",
  LongTextArea: "textarea",
  Email: "email",
  Phone: "phone",
  Url: "url",
  Number: "double",
  Currency: "currency",
  Percent: "percent",
  Checkbox: "boolean",
  Date: "date",
  DateTime: "datetime",
  Picklist: "picklist",
  MultiselectPicklist: "multipicklist",
  Lookup: "reference",
  MasterDetail: "reference",
  AutoNumber: "string",
};

const FIXED_LENGTH: Partial<Record<FieldType, number>> = {
  TextArea: 255,
  Email: 80,
  Phone: 40,
  Url: 255,
  Picklist: 255,
  MultiselectPicklist: 4099,
  Lookup: 18,
  MasterDetail: 18,
  AutoNumber: 30,
};

function blankField(name: string, label: string, type: string): FieldDescribe {
  return {
    name,
    label,
    type,
    length: 0,
    precision: 0,
    scale: 0,
    nillable: true,
    unique: false,
    caseSensitive: false,
    externalId: false,
    custom: false,
    nameField: false,
    autoNumber: false,
    calculated: false,
    createable: false,
    updateable: false,
    defaultedOnCreate: false,
    defaultValue: null,
    inlineHelpText: null,
    picklistValues: [],
    restrictedPicklist: false,
    referenceTo: [],
    relationshipName: null,
    relationshipOrder: null,
    cascadeDelete: false,
    restrictedDelete: false,
    extraTypeInfo: null,
  };
}

function systemReference(
  name: string,
  label: string,
  relationship: string,
  target: string,
  writable: boolean,
): FieldDescribe {
  return {
    ...blankField(name, label, "reference"),
    length: 18,
    nillable: false,
    referenceTo: [target],
    relationshipName: relationship,
    createable: writable,
    updateable: writable,
    defaultedOnCreate: true,
  };
}

function systemDate(name: string, label: string): FieldDescribe {
  return { ...blankField(name, label, "datetime"), nillable: false, defaultedOnCreate: true };
}

function describeField(
  meta: ObjectMeta,
  f: FieldRow,
  masterDetailOrder: Map<string, number>,
): FieldDescribe {
  const props = f.props as Record<string, unknown>;
  const d = blankField(f.api_name, f.label, SOAP_TYPE[f.type]);
  const platform = meta.object.storage === "platform";
  d.custom = f.is_custom;
  d.nameField = f.is_name_field;
  d.unique = f.is_unique;
  d.externalId = f.is_external_id;
  d.caseSensitive = props.caseSensitive === true;
  d.inlineHelpText = f.help_text;
  d.autoNumber = f.type === "AutoNumber";
  d.createable = !platform && !d.autoNumber;
  d.updateable = !platform && !d.autoNumber && f.type !== "MasterDetail";
  d.nillable = !f.required && f.type !== "Checkbox" && !d.autoNumber;
  d.length = typeof props.length === "number" ? props.length : (FIXED_LENGTH[f.type] ?? 0);
  if (f.type === "Number" || f.type === "Currency" || f.type === "Percent") {
    d.length = 0;
    d.precision = Number(props.precision);
    d.scale = Number(props.scale);
  }
  if (f.type === "LongTextArea") d.extraTypeInfo = "plaintextarea";
  if (f.type === "Checkbox") {
    d.defaultValue = props.defaultValue === true;
    d.defaultedOnCreate = true;
  }
  if (d.autoNumber) d.defaultedOnCreate = true;
  if (f.type === "Picklist" || f.type === "MultiselectPicklist") {
    const values = meta.picklistValues.get(f.id) ?? [];
    d.picklistValues = values.map((v) => ({
      value: v.value,
      label: v.label,
      active: v.is_active,
      defaultValue: v.is_default,
    }));
    d.restrictedPicklist = props.restricted === true;
    d.defaultedOnCreate = values.some((v) => v.is_default);
  }
  if (f.reference_to) {
    d.referenceTo = [meta.referenceNames.get(f.reference_to) ?? ""];
    d.relationshipName = parentRelationshipName(f.api_name, f.is_custom);
    d.cascadeDelete = f.delete_constraint === "Cascade";
    d.restrictedDelete = f.delete_constraint === "Restrict";
    if (f.type === "MasterDetail") d.relationshipOrder = masterDetailOrder.get(f.id) ?? 0;
  }
  return d;
}

export function buildDescribe(meta: ObjectMeta): ObjectDescribe {
  const { object } = meta;
  const platform = object.storage === "platform";
  const masterDetail = meta.fields.filter((f) => f.type === "MasterDetail");
  const masterDetailOrder = new Map(masterDetail.map((f, i) => [f.id, i]));

  const fields: FieldDescribe[] = [
    {
      ...blankField("Id", `${object.label} ID`, "id"),
      length: 18,
      nillable: false,
      defaultedOnCreate: true,
    },
  ];
  const nameField = meta.fields.find((f) => f.is_name_field);
  if (nameField) fields.push(describeField(meta, nameField, masterDetailOrder));
  if (!platform) {
    if (object.sharing_model !== "ControlledByParent") {
      fields.push(systemReference("OwnerId", "Owner ID", "Owner", "User", true));
    }
    if (meta.recordTypes.length > 0) {
      fields.push({
        ...systemReference("RecordTypeId", "Record Type ID", "RecordType", "RecordType", true),
        nillable: true,
      });
    }
    fields.push({
      ...blankField("IsDeleted", "Deleted", "boolean"),
      nillable: false,
      defaultedOnCreate: true,
    });
  }
  for (const f of meta.fields)
    if (!f.is_name_field) fields.push(describeField(meta, f, masterDetailOrder));
  if (!platform) {
    fields.push(
      systemDate("CreatedDate", "Created Date"),
      systemReference("CreatedById", "Created By ID", "CreatedBy", "User", false),
      systemDate("LastModifiedDate", "Last Modified Date"),
      systemReference("LastModifiedById", "Last Modified By ID", "LastModifiedBy", "User", false),
      systemDate("SystemModstamp", "System Modstamp"),
    );
  }

  const childRelationships = meta.children.map(({ field, childObject }) => ({
    childSObject: childObject,
    field: field.api_name,
    relationshipName: childRelationshipName(field.relationship_name ?? "", field.is_custom),
    cascadeDelete: field.delete_constraint === "Cascade",
    restrictedDelete: field.delete_constraint === "Restrict",
  }));

  const recordTypeInfos: RecordTypeInfo[] = [
    ...meta.recordTypes.map((rt, i) => ({
      recordTypeId: rt.id,
      developerName: rt.developer_name,
      name: rt.label,
      active: rt.is_active,
      available: rt.is_active,
      defaultRecordTypeMapping: i === 0 && rt.is_active,
      master: false,
    })),
    {
      recordTypeId: MASTER_RECORD_TYPE_ID,
      developerName: "Master",
      name: "Master",
      active: true,
      available: true,
      // Master is the default only when the object has no active record types.
      defaultRecordTypeMapping: !meta.recordTypes.some((r) => r.is_active),
      master: true,
    },
  ];

  return {
    name: object.api_name,
    label: object.label,
    labelPlural: object.plural_label,
    keyPrefix: object.key_prefix,
    custom: object.is_custom,
    createable: !platform,
    updateable: !platform,
    deletable: !platform,
    sharingModel: object.sharing_model,
    fields,
    childRelationships,
    recordTypeInfos,
  };
}

export async function describeObject(ctx: Ctx, apiName: string): Promise<ObjectDescribe> {
  return buildDescribe(await loadObjectMeta(ctx, apiName));
}

export async function describeGlobal(ctx: Ctx): Promise<GlobalDescribeEntry[]> {
  const rows = await ctx.tx
    .selectFrom("object_def")
    .select(["api_name", "label", "plural_label", "key_prefix", "is_custom"])
    .orderBy("api_name")
    .execute();
  return rows.map((r) => ({
    name: r.api_name,
    label: r.label,
    labelPlural: r.plural_label,
    keyPrefix: r.key_prefix,
    custom: r.is_custom,
  }));
}

/** Values a record type offers for a picklist field (what a record form would show). */
export async function picklistValuesForRecordType(
  ctx: Ctx,
  objectApiName: string,
  fieldApiName: string,
  recordTypeDeveloperName: string,
): Promise<{ values: PicklistEntry[]; defaultValue: string | null }> {
  const meta = await loadObjectMeta(ctx, objectApiName);
  const field = meta.fields.find((f) => f.api_name.toLowerCase() === fieldApiName.toLowerCase());
  const all = field ? (meta.picklistValues.get(field.id) ?? []) : [];
  if (!field || all.length === 0) return { values: [], defaultValue: null };
  const toEntry = (v: (typeof all)[number], isDefault: boolean): PicklistEntry => ({
    value: v.value,
    label: v.label,
    active: v.is_active,
    defaultValue: isDefault,
  });
  if (recordTypeDeveloperName.toLowerCase() === "master") {
    const active = all.filter((v) => v.is_active);
    return {
      values: active.map((v) => toEntry(v, v.is_default)),
      defaultValue: active.find((v) => v.is_default)?.value ?? null,
    };
  }
  const rt = meta.recordTypes.find(
    (r) => r.developer_name.toLowerCase() === recordTypeDeveloperName.toLowerCase(),
  );
  const offered = rt ? (meta.recordTypeValues.get(rt.id)?.get(field.id) ?? []) : [];
  const byValue = new Map(all.map((v) => [v.value, v]));
  const values = offered
    .map((o) => {
      const v = byValue.get(o.value);
      return v?.is_active ? toEntry(v, o.isDefault) : null;
    })
    .filter((x): x is PicklistEntry => x !== null);
  return { values, defaultValue: values.find((v) => v.defaultValue)?.value ?? null };
}
