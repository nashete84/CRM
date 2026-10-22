/**
 * Objects whose rows live in platform tables rather than the generic record
 * table (DECISIONS.md D-024). They are described like any other object so
 * lookups, OwnerId and CreatedById can point at them, but their fields are
 * fixed: each maps to a column of the backing table.
 */
export type PlatformField = {
  apiName: string;
  label: string;
  type: "Text" | "Email" | "Checkbox";
  column: string;
  length?: number;
  isNameField?: boolean;
};

export type PlatformObject = {
  apiName: string;
  label: string;
  pluralLabel: string;
  keyPrefix: string;
  table: string;
  fields: PlatformField[];
};

export const PLATFORM_OBJECTS: readonly PlatformObject[] = [
  {
    apiName: "User",
    label: "User",
    pluralLabel: "Users",
    keyPrefix: "005",
    table: "app_user",
    fields: [
      {
        apiName: "Name",
        label: "Full Name",
        type: "Text",
        column: "name",
        length: 255,
        isNameField: true,
      },
      { apiName: "Email", label: "Email", type: "Email", column: "email" },
      { apiName: "IsActive", label: "Active", type: "Checkbox", column: "is_active" },
      {
        apiName: "TimeZoneSidKey",
        label: "Time Zone",
        type: "Text",
        column: "time_zone",
        length: 40,
      },
      {
        apiName: "LanguageLocaleKey",
        label: "Language",
        type: "Text",
        column: "locale",
        length: 40,
      },
    ],
  },
];
