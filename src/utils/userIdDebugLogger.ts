/**
 * Debug logger for tracking userId edge cases and potential security issues
 * This helps identify race conditions, data leakage, and unauthorized access
 */

interface UserIdLogEntry {
  timestamp: string;
  type: 'AUTH_CHANGE' | 'OPERATION_START' | 'OPERATION_END' | 'SERVICE_CALL' | 'STORE_UPDATE' | 'ERROR';
  component: string;
  userId: string | null | undefined;
  operationId?: string;
  details?: any;
  stackTrace?: string;
}

class UserIdDebugLogger {
  private logs: UserIdLogEntry[] = [];
  private maxLogs = 1000; // Keep last 1000 logs
  private isEnabled = false; // typeof window !== 'undefined' && window.localStorage.getItem('debug-userId') === 'true';

  log(entry: Omit<UserIdLogEntry, 'timestamp'>) {
    if (!this.isEnabled) return;

    const logEntry: UserIdLogEntry = {
      timestamp: new Date().toISOString(),
      ...entry
    };

    this.logs.push(logEntry);
    
    // Keep only the last maxLogs entries
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }

    // Log to console with color coding
    const colors = {
      AUTH_CHANGE: 'color: #FF6B6B; font-weight: bold',
      OPERATION_START: 'color: #4ECDC4; font-weight: bold',
      OPERATION_END: 'color: #45B7D1; font-weight: bold',
      SERVICE_CALL: 'color: #96CEB4; font-weight: bold',
      STORE_UPDATE: 'color: #FFEAA7; font-weight: bold',
      ERROR: 'color: #E17055; font-weight: bold; background: #FAB1A0; padding: 2px 4px'
    };

    console.log(
      `%c[USERID-DEBUG] ${entry.type} | ${entry.component} | userId: ${entry.userId || 'NULL'}`,
      colors[entry.type] || 'color: gray',
      entry
    );

    // Check for potential issues
    this.checkForIssues(logEntry);
  }

  private checkForIssues(entry: UserIdLogEntry) {
    // Check for null/undefined userId in operations that should have it
    if ((entry.type === 'OPERATION_START' || entry.type === 'SERVICE_CALL') && 
        (!entry.userId || entry.userId === 'undefined')) {
      console.error(
        `%c[USERID-SECURITY-ISSUE] Operation started without valid userId`,
        'color: red; font-weight: bold; background: #FFE5E5; padding: 4px',
        entry
      );
    }

    // Check for race conditions
    if (entry.type === 'OPERATION_END' && entry.operationId) {
      const startEntry = this.logs.find(
        log => log.operationId === entry.operationId && log.type === 'OPERATION_START'
      );
      if (startEntry && startEntry.userId !== entry.userId) {
        console.error(
          `%c[USERID-RACE-CONDITION] userId changed during operation!`,
          'color: red; font-weight: bold; background: #FFE5E5; padding: 4px',
          { start: startEntry, end: entry }
        );
      }
    }

    // Check for auth changes during operations
    if (entry.type === 'AUTH_CHANGE') {
      const activeOperations = this.logs.filter(
        log => log.type === 'OPERATION_START' && 
               !this.logs.some(endLog => 
                 endLog.operationId === log.operationId && endLog.type === 'OPERATION_END'
               )
      );
      
      if (activeOperations.length > 0) {
        console.warn(
          `%c[USERID-WARNING] Auth state changed while ${activeOperations.length} operations are active`,
          'color: orange; font-weight: bold; background: #FFF3CD; padding: 4px',
          { authChange: entry, activeOperations }
        );
      }
    }
  }

  // Helper methods for specific logging scenarios
  logAuthChange(component: string, userId: string | null, event: string) {
    this.log({
      type: 'AUTH_CHANGE',
      component,
      userId,
      details: { event }
    });
  }

  logOperationStart(component: string, operation: string, userId: string | null, operationId?: string) {
    const id = operationId || `${operation}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.log({
      type: 'OPERATION_START',
      component,
      userId,
      operationId: id,
      details: { operation }
    });
    return id;
  }

  logOperationEnd(component: string, operationId: string, userId: string | null) {
    this.log({
      type: 'OPERATION_END',
      component,
      userId,
      operationId,
      details: { operationCompleted: true }
    });
  }

  logServiceCall(component: string, service: string, method: string, userId: string | null) {
    this.log({
      type: 'SERVICE_CALL',
      component: `${component}.${service}`,
      userId,
      details: { method }
    });
  }

  logStoreUpdate(store: string, userId: string | null, action: string) {
    this.log({
      type: 'STORE_UPDATE',
      component: store,
      userId,
      details: { action }
    });
  }

  logError(component: string, error: Error | string, userId: string | null) {
    this.log({
      type: 'ERROR',
      component,
      userId,
      details: { error: error instanceof Error ? error.message : error },
      stackTrace: error instanceof Error ? error.stack : undefined
    });
  }

  // Analysis methods
  getLogs(): UserIdLogEntry[] {
    return [...this.logs];
  }

  getRaceConditions(): Array<{start: UserIdLogEntry, end: UserIdLogEntry}> {
    const raceConditions: Array<{start: UserIdLogEntry, end: UserIdLogEntry}> = [];
    
    this.logs.forEach(endEntry => {
      if (endEntry.type === 'OPERATION_END' && endEntry.operationId) {
        const startEntry = this.logs.find(
          log => log.operationId === endEntry.operationId && log.type === 'OPERATION_START'
        );
        if (startEntry && startEntry.userId !== endEntry.userId) {
          raceConditions.push({ start: startEntry, end: endEntry });
        }
      }
    });

    return raceConditions;
  }

  getUnauthorizedAccessAttempts(): UserIdLogEntry[] {
    return this.logs.filter(log => 
      (log.type === 'OPERATION_START' || log.type === 'SERVICE_CALL') && 
      (!log.userId || log.userId === 'undefined' || log.userId === 'null')
    );
  }

  exportLogs(): string {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      logs: this.logs,
      analysis: {
        raceConditions: this.getRaceConditions(),
        unauthorizedAttempts: this.getUnauthorizedAccessAttempts(),
        totalLogs: this.logs.length
      }
    }, null, 2);
  }

  clearLogs() {
    this.logs = [];
  }
}

// Create singleton instance
export const userIdLogger = new UserIdDebugLogger();

// Helper function to generate operation IDs
export function generateOperationId(operation: string): string {
  return `${operation}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Enable debug logging in development or with localStorage flag
if (typeof window !== 'undefined') {
  // Add global debug functions
  (window as any).userIdDebug = {
    getLogs: () => userIdLogger.getLogs(),
    getRaceConditions: () => userIdLogger.getRaceConditions(),
    getUnauthorizedAttempts: () => userIdLogger.getUnauthorizedAccessAttempts(),
    exportLogs: () => userIdLogger.exportLogs(),
    clearLogs: () => userIdLogger.clearLogs(),
    enable: () => window.localStorage.setItem('debug-userId', 'true'),
    disable: () => window.localStorage.removeItem('debug-userId')
  };
  
  console.log('UserId Debug Logger initialized. Use window.userIdDebug to access logs.');
}