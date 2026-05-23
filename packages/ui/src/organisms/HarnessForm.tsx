import { useState } from "react"
import type { ReactElement } from "react"
import type { ApiFormat } from "@launchkit/types"
import { Button } from "../atoms/Button"
import { Select } from "../atoms/Select"
import { TextInput } from "../atoms/TextInput"
import { FormField } from "../molecules/FormField"

export type HarnessFormValues = {
  readonly name: string
  readonly command: string
  readonly apiFormat: ApiFormat
  readonly defaultAlias: string
}

export type HarnessFormProps = {
  readonly initialValues: HarnessFormValues
  readonly onSubmit: (values: HarnessFormValues) => void
  readonly onCancel: () => void
}

const API_FORMAT_OPTIONS = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
] as const

export const HarnessForm = ({ initialValues, onSubmit, onCancel }: HarnessFormProps): ReactElement => {
  const [values, setValues] = useState<HarnessFormValues>(initialValues)
  const update = <K extends keyof HarnessFormValues>(key: K, value: HarnessFormValues[K]): void =>
    setValues((prev) => ({ ...prev, [key]: value }))

  const submit = (): void => {
    if (values.name.trim() === "" || values.command.trim() === "") return
    onSubmit(values)
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <FormField id="harness-name" label="Name">
        <TextInput id="harness-name" value={values.name} onChange={(v) => update("name", v)} />
      </FormField>
      <FormField id="harness-command" label="Command">
        <TextInput id="harness-command" value={values.command} onChange={(v) => update("command", v)} />
      </FormField>
      <FormField id="harness-format" label="API format">
        <Select
          id="harness-format"
          value={values.apiFormat}
          options={API_FORMAT_OPTIONS}
          onChange={(v) => update("apiFormat", v as ApiFormat)}
        />
      </FormField>
      <FormField id="harness-alias" label="Default alias">
        <TextInput id="harness-alias" value={values.defaultAlias} onChange={(v) => update("defaultAlias", v)} />
      </FormField>
      <Button onClick={() => submit()}>Save</Button>
      <Button variant="secondary" onClick={() => onCancel()}>Cancel</Button>
    </form>
  )
}
