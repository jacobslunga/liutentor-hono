import type { ApiResponse } from '../../types/api';

export function success<T>(payload: T, message = 'OK'): ApiResponse<T> {
  return {
    success: true,
    message,
    payload,
  };
}

export function fail(message: string): ApiResponse<null> {
  return {
    success: false,
    message,
    payload: null,
  };
}
