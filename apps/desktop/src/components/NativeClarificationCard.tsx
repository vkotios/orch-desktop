import { useId, useState } from "react";
import type { NativeClarificationRequest } from "../lib/api";

const ANSWER_MAX_LENGTH = 4096;

interface NativeClarificationCardProps {
  request: NativeClarificationRequest;
  disabled: boolean;
  onAnswer: (answers: Record<string, string[]>) => void;
}

function validAnswer(
  multiSelect: boolean,
  hasOptions: boolean,
  isOther: boolean,
  selected: string[],
  custom: string,
): string[] | null {
  const customActive = custom.trim() !== "";
  if (!hasOptions) {
    if (!customActive || custom.length > ANSWER_MAX_LENGTH) return null;
    return [custom];
  }
  if (customActive) {
    if (!isOther || custom.length > ANSWER_MAX_LENGTH) return null;
    return [custom];
  }
  if (selected.length === 0) return null;
  if (!multiSelect && selected.length !== 1) return null;
  if (selected.length > 8) return null;
  return selected;
}

export function NativeClarificationCard({ request, disabled, onAnswer }: NativeClarificationCardProps) {
  const instanceId = useId().replace(/:/g, "");
  const [chosen, setChosen] = useState<string[][]>(() => request.questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(() => request.questions.map(() => ""));
  const busy = disabled || request.answering;

  function choose(questionIndex: number, label: string, multi: boolean) {
    setChosen((prev) =>
      prev.map((selection, i) => {
        if (i !== questionIndex) return selection;
        if (multi) {
          return selection.includes(label)
            ? selection.filter((item) => item !== label)
            : [...selection, label];
        }
        return [label];
      }),
    );
    setCustom((prev) => prev.map((text, i) => (i === questionIndex ? "" : text)));
  }

  function changeCustom(questionIndex: number, value: string) {
    setCustom((prev) => prev.map((text, i) => (i === questionIndex ? value : text)));
    setChosen((prev) => prev.map((selection, i) => (i === questionIndex ? [] : selection)));
  }

  const answers = request.questions.map((question, i) =>
    validAnswer(
      question.multiSelect,
      question.options !== null,
      question.isOther,
      chosen[i] ?? [],
      custom[i] ?? "",
    ),
  );
  const valid = answers.every((answer) => answer !== null);

  function submit() {
    if (!valid || busy) return;
    const out: Record<string, string[]> = {};
    request.questions.forEach((question, i) => {
      const answer = answers[i];
      if (answer) {
        Object.defineProperty(out, question.id, {
          value: answer,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    });
    onAnswer(out);
  }

  return (
    <section className="native-clarification" aria-label="Input needed">
      <p className="native-clarification-title">Input needed</p>
      {request.questions.map((question, qi) => {
        const selected = chosen[qi] ?? [];
        const text = custom[qi] ?? "";
        const customId = `clar-custom-${instanceId}-${qi}`;
        return (
          <fieldset key={qi} className="native-clarification-question">
            <legend>{question.header}</legend>
            <p className="native-clarification-text">{question.question}</p>
            {question.options === null ? (
              <label className="native-clarification-custom" htmlFor={customId}>
                Your answer
                <textarea
                  id={customId}
                  value={text}
                  maxLength={ANSWER_MAX_LENGTH}
                  rows={3}
                  disabled={busy}
                  onChange={(e) => changeCustom(qi, e.target.value)}
                />
              </label>
            ) : (
              <>
                <div className="native-clarification-options">
                  {question.options.map((option) => (
                    <label key={option.label} className="native-clarification-option">
                      <input
                        type={question.multiSelect ? "checkbox" : "radio"}
                        name={`clar-${request.clarificationId}-${qi}`}
                        checked={selected.includes(option.label)}
                        disabled={busy}
                        onChange={() => choose(qi, option.label, question.multiSelect)}
                      />
                      <span>
                        <span>{option.label}</span>
                        {option.description !== "" && <small>{option.description}</small>}
                      </span>
                    </label>
                  ))}
                </div>
                {question.isOther && (
                  <label className="native-clarification-custom" htmlFor={customId}>
                    Or enter your own answer
                    <textarea
                      id={customId}
                      value={text}
                      maxLength={ANSWER_MAX_LENGTH}
                      rows={3}
                      disabled={busy}
                      onChange={(e) => changeCustom(qi, e.target.value)}
                    />
                  </label>
                )}
              </>
            )}
          </fieldset>
        );
      })}
      {request.answerError && (
        <p role="alert" className="native-clarification-error">
          {request.answerError}
        </p>
      )}
      <div className="native-clarification-actions">
        <button className="native-primary" onClick={submit} disabled={!valid || busy}>
          {request.questions.length === 1 ? "Send answer" : "Send answers"}
        </button>
        {request.answering && (
          <span role="status" className="native-clarification-status">
            Sending answer…
          </span>
        )}
      </div>
    </section>
  );
}
