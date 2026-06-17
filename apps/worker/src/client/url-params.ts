export function getEffectiveSearchParams(search = window.location.search): URLSearchParams {
  const directParams = new URLSearchParams(search);
  const merged = new URLSearchParams();
  const stateParams = parseLiffStateParams(directParams.get('liff.state'));

  for (const [key, value] of stateParams) {
    merged.set(key, value);
  }
  for (const [key, value] of directParams) {
    if (key !== 'liff.state') {
      merged.set(key, value);
    }
  }

  return merged;
}

function parseLiffStateParams(rawState: string | null): URLSearchParams {
  const params = new URLSearchParams();
  if (!rawState) return params;

  let state = rawState;
  try {
    state = decodeURIComponent(rawState);
  } catch {
    // URLSearchParams usually decodes values already. Keep the raw value.
  }

  const queryStart = state.indexOf('?');
  const query = queryStart >= 0 ? state.slice(queryStart + 1) : state.replace(/^&+/, '');
  if (!query) return params;

  const parsed = new URLSearchParams(query);
  for (const [key, value] of parsed) {
    params.set(key, value);
  }
  return params;
}
