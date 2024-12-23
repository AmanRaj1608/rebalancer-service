export function logInfo(message: string) {
  console.log(`[INFO] ${new Date().toISOString()} - ${message}`);
}

export function logError(message: string, error?: any) {
  console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, error);
}

export function logWarning(message: string) {
  console.warn(`[WARNING] ${new Date().toISOString()} - ${message}`);
}

export function logDebug(message: string) {
  if (process.env.NODE_ENV === "development") {
    console.debug(`[DEBUG] ${new Date().toISOString()} - ${message}`);
  }
}
