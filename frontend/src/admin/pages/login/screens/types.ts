// The auth screens share one shell; `go` swaps between them.
// Username recovery is gone (P1 auth overhaul): the login identifier IS the
// email address, so there is nothing to recover — the server answers 410.
export type Screen = 'signin' | 'forgot-password' | 'signup';
