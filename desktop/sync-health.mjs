export function usesMacCalendars(connection) {
  return connection.provider === 'mac' || connection.route === 'mac';
}

export function failedCheck(connectionId, error, sourceId, checkedAt = null) {
  return {
    connectionId, ...(sourceId && { sourceId }), state: checkedAt ? 'stale' : 'error', checkedAt,
    message: error.message, ...(typeof error.code === 'string' && { code: error.code }),
    ...(Number.isInteger(error.status) && { status: error.status }),
    ...(Number.isFinite(error.retryAt) && { retryAt: error.retryAt }),
  };
}
