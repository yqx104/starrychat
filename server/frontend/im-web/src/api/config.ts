// An unset value uses a same-origin reverse proxy; no backend port is assumed.
export const apiBaseUrl = (import.meta.env.VITE_IM_API_BASE_URL ?? '/im-api').replace(/\/+$/, '');
