export function serializeSubscriberRecord<T>(record: T): T {
  return JSON.parse(JSON.stringify(record)) as T;
}

export function serializeSubscriberRecords<T>(records: readonly T[]): T[] {
  return records.map(serializeSubscriberRecord);
}

export const SECRET_SHAPE_CORPUS = [
  {
    name: "bearer",
    value: "jst_bearer_value_123",
    sample: "Authorization: Bearer jst_bearer_value_123"
  },
  {
    name: "query api_key",
    value: "query-api-key-value",
    sample: "https://example.test?api_key=query-api-key-value"
  },
  {
    name: "query token",
    value: "query-token-value",
    sample: "https://example.test?token=query-token-value"
  },
  {
    name: "query secret",
    value: "query-secret-value",
    sample: "https://example.test?secret=query-secret-value"
  },
  {
    name: "query password",
    value: "query-password-value",
    sample: "https://example.test?password=query-password-value"
  },
  {
    name: "query authorization",
    value: "query-auth-value",
    sample: "https://example.test?authorization=query-auth-value"
  },
  { name: "json apiKey", value: "json-api-key-value", sample: '{"apiKey":"json-api-key-value"}' },
  { name: "json token", value: "json-token-value", sample: '{"token":"json-token-value"}' },
  { name: "json secret", value: "json-secret-value", sample: '{"secret":"json-secret-value"}' },
  {
    name: "json password",
    value: "json-password-value",
    sample: '{"password":"json-password-value"}'
  },
  {
    name: "json authorization",
    value: "json-auth-value",
    sample: '{"authorization":"json-auth-value"}'
  },
  { name: "env api key", value: "env-api-key-value", sample: "API_KEY=env-api-key-value" },
  { name: "env token", value: "env-token-value", sample: "TOKEN=env-token-value" },
  { name: "env secret", value: "env-secret-value", sample: "SECRET=env-secret-value" },
  { name: "env password", value: "env-password-value", sample: "PASSWORD=env-password-value" },
  { name: "env authorization", value: "env-auth-value", sample: "AUTHORIZATION=env-auth-value" },
  { name: "sk prefix", value: "sk-api-value-123456", sample: "sk-api-value-123456" },
  {
    name: "sk-ant prefix",
    value: "sk-ant-api03-value-123456",
    sample: "sk-ant-api03-value-123456"
  },
  { name: "ghp prefix", value: "ghp_1234567890abcdef", sample: "ghp_1234567890abcdef" },
  { name: "xox prefix", value: "xoxb-1234567890abcdef", sample: "xoxb-1234567890abcdef" },
  { name: "AKIA prefix", value: "AKIA1234567890ABCD", sample: "AKIA1234567890ABCD" }
] as const;
