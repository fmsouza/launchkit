import { describe, expect, it } from "bun:test"
import { configSchemaFromFields } from "./config-schema-from-fields"
import type { ConfigFieldSpec } from "./types"

const urlField: ConfigFieldSpec = {
  name: "serverUrl",
  label: "Server URL",
  kind: "url",
  required: false,
}
const headersField: ConfigFieldSpec = {
  name: "headers",
  label: "Custom headers",
  kind: "headers",
  required: false,
}
const textField: ConfigFieldSpec = {
  name: "region",
  label: "AWS region",
  kind: "text",
  required: true,
}

describe("configSchemaFromFields", () => {
  it("accepts a well-formed url when the field kind is url", () => {
    const schema = configSchemaFromFields([urlField])
    expect(
      schema.safeParse({ serverUrl: "http://127.0.0.1:9000/v1" }).success,
    ).toBe(true)
  })

  it("rejects a malformed url when the field kind is url", () => {
    const schema = configSchemaFromFields([urlField])
    expect(schema.safeParse({ serverUrl: "not a url" }).success).toBe(false)
  })

  it("omits an optional field when it is absent", () => {
    const schema = configSchemaFromFields([urlField])
    expect(schema.safeParse({}).success).toBe(true)
  })

  it("rejects the object when a required text field is missing", () => {
    const schema = configSchemaFromFields([textField])
    expect(schema.safeParse({}).success).toBe(false)
  })

  it("accepts a JSON object of strings when the field kind is headers", () => {
    const schema = configSchemaFromFields([headersField])
    expect(schema.safeParse({ headers: '{"X-Api":"v1"}' }).success).toBe(true)
  })

  it("rejects a headers value when a member is not a string", () => {
    const schema = configSchemaFromFields([headersField])
    expect(schema.safeParse({ headers: '{"X-Api":3}' }).success).toBe(false)
  })

  it("rejects an unknown key when it is not a declared field", () => {
    const schema = configSchemaFromFields([urlField])
    expect(
      schema.safeParse({ serverUrl: "http://a.b/v1", nope: "x" }).success,
    ).toBe(false)
  })
})
