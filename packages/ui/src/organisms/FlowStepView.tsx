import type { ReactElement } from "react"
import { useState } from "react"
import { Badge } from "../atoms/Badge"
import type { BadgeTone } from "../atoms/Badge"
import { Button } from "../atoms/Button"
import { Select } from "../atoms/Select"
import type { SelectOption } from "../atoms/Select"
import { Spinner } from "../atoms/Spinner"
import { TextInput } from "../atoms/TextInput"
import type { TextInputType } from "../atoms/TextInput"
import { FormField } from "../molecules/FormField"

/**
 * A hand-written structural subset of the setup-flow protocol, declared LOCALLY rather than
 * imported from `@spectrum/ipc` (`FlowStepViewData`) — this package never depends on `ipc`
 * or `extensions`. Follows the precedent of `ProviderList`'s `ProviderRow`.
 */
export type FlowFormFieldView = {
  readonly name: string
  readonly label: string
  readonly kind: "text" | "url" | "password" | "select"
  readonly required: boolean
  readonly placeholder?: string
  readonly options?: readonly SelectOption[]
}

export type FlowFormStepView = {
  readonly kind: "form"
  readonly title: string
  readonly description?: string
  readonly fields: readonly FlowFormFieldView[]
  readonly submitLabel?: string
}

export type FlowMessageStepView = {
  readonly kind: "message"
  readonly title: string
  readonly body: string
  readonly tone: "info" | "success" | "warning"
  readonly continueLabel?: string
}

export type FlowOpenExternalStepView = {
  readonly kind: "open-external"
  readonly title: string
  readonly description?: string
  readonly url: string
  readonly buttonLabel?: string
}

export type FlowAwaitStepView = {
  readonly kind: "await"
  readonly title: string
  readonly description?: string
  readonly pollMs: number
}

export type FlowDoneStepView = {
  readonly kind: "done"
  readonly message?: string
}

export type FlowErrorStepView = {
  readonly kind: "error"
  readonly message: string
}

/**
 * A step `kind` this build of Spectrum does not recognize — e.g. a newer extension speaking a
 * newer flow protocol than this Spectrum understands. Modeled explicitly, with only `kind`
 * guaranteed, rather than excluded from the union: that is what stops the renderer from being
 * written as an exhaustive switch that would throw (or silently drop the step) the moment a
 * plugin sends a kind this build has never heard of. Spec §10.2.
 */
export type FlowUnknownStepView = {
  readonly kind: string
}

export type FlowStep =
  | FlowFormStepView
  | FlowMessageStepView
  | FlowOpenExternalStepView
  | FlowAwaitStepView
  | FlowDoneStepView
  | FlowErrorStepView
  | FlowUnknownStepView

export type FlowStepViewProps = {
  readonly step: FlowStep
  readonly onSubmit: (values: Readonly<Record<string, string>>) => void
  readonly onAck: () => void
  readonly onCancel: () => void
  readonly busy: boolean
}

const MESSAGE_TONE_TO_BADGE: Record<FlowMessageStepView["tone"], BadgeTone> = {
  info: "info",
  success: "success",
  warning: "warning",
}

const initialValues = (
  fields: readonly FlowFormFieldView[],
): Record<string, string> => {
  const values: Record<string, string> = {}
  for (const field of fields) {
    values[field.name] =
      field.kind === "select" ? (field.options?.[0]?.value ?? "") : ""
  }
  return values
}

const textInputType = (kind: FlowFormFieldView["kind"]): TextInputType =>
  kind === "select" ? "text" : kind

/** Renders one extension-contributed setup-flow step with Spectrum's own components. No IPC,
 * no polling — the page owns the timer and supplies `busy` and the callbacks. */
export const FlowStepView = ({
  step,
  onSubmit,
  onAck,
  onCancel,
  busy,
}: FlowStepViewProps): ReactElement => {
  // `FlowUnknownStepView.kind` is typed as plain `string` (deliberately — see its doc
  // comment), so it overlaps every literal below and TypeScript's discriminant narrowing
  // can't exclude it the way it would from a closed union. The casts here are the runtime
  // check standing in for a static one: each branch only runs once `step.kind` has already
  // been compared to the matching literal.
  return (
    <div className="lk-flow-step">
      {step.kind === "form" ? (
        <FormStep
          step={step as FlowFormStepView}
          onSubmit={onSubmit}
          busy={busy}
        />
      ) : step.kind === "message" ? (
        <MessageStep
          step={step as FlowMessageStepView}
          onAck={onAck}
          busy={busy}
        />
      ) : step.kind === "open-external" ? (
        <OpenExternalStep
          step={step as FlowOpenExternalStepView}
          onAck={onAck}
          busy={busy}
        />
      ) : step.kind === "await" ? (
        <AwaitStep step={step as FlowAwaitStepView} />
      ) : step.kind === "done" ? (
        <p>{(step as FlowDoneStepView).message ?? "Done"}</p>
      ) : step.kind === "error" ? (
        <p role="alert">{(step as FlowErrorStepView).message}</p>
      ) : (
        <p>This step needs a newer Spectrum.</p>
      )}
      {/* Cancel is always present and never disabled by `busy` — a hung flow must stay
       * cancellable regardless of what the current step is doing. */}
      <Button variant="secondary" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  )
}

const FormStep = ({
  step,
  onSubmit,
  busy,
}: {
  readonly step: FlowFormStepView
  readonly onSubmit: (values: Readonly<Record<string, string>>) => void
  readonly busy: boolean
}): ReactElement => {
  const [values, setValues] = useState<Record<string, string>>(() =>
    initialValues(step.fields),
  )
  const missingRequired = step.fields.some(
    (f) => f.required && (values[f.name] ?? "") === "",
  )
  return (
    <div>
      <h3>{step.title}</h3>
      {step.description !== undefined ? <p>{step.description}</p> : null}
      {step.fields.map((field) => (
        <FormField
          id={`flow-field-${field.name}`}
          label={field.label}
          key={field.name}
        >
          {field.kind === "select" ? (
            <Select
              id={`flow-field-${field.name}`}
              value={values[field.name] ?? ""}
              options={field.options ?? []}
              disabled={busy}
              onChange={(v) =>
                setValues((prev) => ({ ...prev, [field.name]: v }))
              }
            />
          ) : (
            <TextInput
              id={`flow-field-${field.name}`}
              type={textInputType(field.kind)}
              value={values[field.name] ?? ""}
              disabled={busy}
              onChange={(v) =>
                setValues((prev) => ({ ...prev, [field.name]: v }))
              }
            />
          )}
        </FormField>
      ))}
      <Button
        onClick={() => onSubmit(values)}
        disabled={busy || missingRequired}
      >
        {step.submitLabel ?? "Continue"}
      </Button>
    </div>
  )
}

const MessageStep = ({
  step,
  onAck,
  busy,
}: {
  readonly step: FlowMessageStepView
  readonly onAck: () => void
  readonly busy: boolean
}): ReactElement => (
  <div>
    <Badge tone={MESSAGE_TONE_TO_BADGE[step.tone]}>{step.title}</Badge>
    <p>{step.body}</p>
    <Button onClick={onAck} disabled={busy}>
      {step.continueLabel ?? "Continue"}
    </Button>
  </div>
)

const OpenExternalStep = ({
  step,
  onAck,
  busy,
}: {
  readonly step: FlowOpenExternalStepView
  readonly onAck: () => void
  readonly busy: boolean
}): ReactElement => (
  <div>
    <h3>{step.title}</h3>
    {step.description !== undefined ? <p>{step.description}</p> : null}
    {/* The user should be able to see the host they were sent to before clicking. */}
    <p>{step.url}</p>
    {/* NOT labelled "Authorize": Spectrum opens the browser server-side when this step is
     * delivered, so by the time this renders authorization has already been requested. This
     * button means "I'm done", not "authorize". */}
    <Button onClick={onAck} disabled={busy}>
      {step.buttonLabel ?? "I've authorized — continue"}
    </Button>
  </div>
)

const AwaitStep = ({
  step,
}: {
  readonly step: FlowAwaitStepView
}): ReactElement => (
  <div>
    <h3>{step.title}</h3>
    {step.description !== undefined ? <p>{step.description}</p> : null}
    {/* No submit control here: the page owns the poll timer, this component only shows that
     * something is happening. */}
    <Spinner label={step.title} />
  </div>
)
