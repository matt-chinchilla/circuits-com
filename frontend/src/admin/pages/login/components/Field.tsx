// Field primitive for the auth screens (ported from the v13 design): label +
// optional right-slot link, icon-lead input shell, optional reveal toggle, and
// an inline error row. Class strings resolve scoped via the .authRoot wrapper.
import type { HTMLAttributes, ReactNode } from 'react';
import { I, Svg } from './icons';

interface FieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  icon?: ReactNode;
  placeholder?: string;
  error?: string;
  autoFocus?: boolean;
  reveal?: boolean;
  onReveal?: () => void;
  revealed?: boolean;
  inputMode?: HTMLAttributes<HTMLInputElement>['inputMode'];
  autoComplete?: string;
  right?: ReactNode;
}

export default function Field({
  id,
  label,
  value,
  onChange,
  type = 'text',
  icon,
  placeholder,
  error,
  autoFocus,
  reveal,
  onReveal,
  revealed,
  inputMode,
  autoComplete = 'off',
  right,
}: FieldProps) {
  return (
    <div className="field">
      <div className="field-top">
        <label htmlFor={id}>{label}</label>
        {right}
      </div>
      <div className={`input-shell has-lead ${error ? 'err' : ''}`}>
        {icon && (
          <span className="lead">
            <Svg d={icon} />
          </span>
        )}
        <input
          id={id}
          type={type}
          value={value}
          placeholder={placeholder}
          inputMode={inputMode}
          autoFocus={autoFocus}
          autoComplete={autoComplete}
          onChange={(e) => onChange(e.target.value)}
        />
        {reveal && (
          <button
            type="button"
            className="reveal"
            onClick={onReveal}
            aria-label={revealed ? 'Hide password' : 'Show password'}
          >
            <Svg d={revealed ? I.eyeOff : I.eye} />
          </button>
        )}
      </div>
      {error && (
        <div className="field-err">
          <Svg d={I.alert} w={13} />
          {error}
        </div>
      )}
    </div>
  );
}
