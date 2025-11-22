
/**
 * Progress Tracker Service
 * 
 * Provides comprehensive progress tracking for document processing operations
 * with real-time updates, detailed status information, and time estimates.
 */

export interface ProgressStep {
  id: string;
  name: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'error' | 'skipped';
  progress: number; // 0-100
  startTime?: number;
  endTime?: number;
  duration?: number;
  error?: string;
  metadata?: Record<string, any>;
}

export interface ProgressOperation {
  id: string;
  type: 'document_ingestion' | 'vector_search' | 'chat_generation' | 'batch_processing';
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'error' | 'cancelled';
  progress: number; // 0-100
  startTime: number;
  endTime?: number;
  duration?: number;
  estimatedDuration?: number;
  currentStep?: string;
  steps: ProgressStep[];
  metadata: {
    sessionId?: string;
    documentId?: string;
    fileName?: string;
    totalItems?: number;
    processedItems?: number;
    [key: string]: any;
  };
  error?: string;
  cancellable: boolean;
  cancelled?: boolean;
}

export interface ProgressEvent {
  operationId: string;
  type: 'start' | 'progress' | 'step_start' | 'step_progress' | 'step_complete' | 'complete' | 'error' | 'cancel';
  data: any;
  timestamp: number;
}

export interface ProgressCallback {
  (event: ProgressEvent): void;
}

class ProgressTracker {
  private operations: Map<string, ProgressOperation> = new Map();
  private listeners: Map<string, ProgressCallback[]> = new Map();
  private globalListeners: ProgressCallback[] = [];

  /**
   * Create a new progress tracking operation
   */
  createOperation(config: Omit<ProgressOperation, 'id' | 'startTime' | 'progress' | 'status' | 'steps'>): ProgressOperation {
    const operation: ProgressOperation = {
      id: this.generateId(),
      startTime: Date.now(),
      progress: 0,
      status: 'pending',
      steps: [],
      ...config
    };

    this.operations.set(operation.id, operation);
    this.emitEvent(operation.id, 'start', { operation });
    
    return operation;
  }

  /**
   * Generate a unique ID for operations and steps
   */
  private generateId(): string {
    return `progress_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Add a step to an operation
   */
  addStep(operationId: string, stepConfig: Omit<ProgressStep, 'id' | 'status' | 'progress'>): ProgressStep {
    const operation = this.operations.get(operationId);
    if (!operation) {
      throw new Error(`Operation ${operationId} not found`);
    }

    const step: ProgressStep = {
      id: this.generateId(),
      status: 'pending',
      progress: 0,
      ...stepConfig
    };

    operation.steps.push(step);
    return step;
  }

  /**
   * Start an operation
   */
  startOperation(operationId: string): void {
    const operation = this.operations.get(operationId);
    if (!operation) {
      throw new Error(`Operation ${operationId} not found`);
    }

    operation.status = 'in_progress';
    operation.startTime = Date.now();
    this.emitEvent(operationId, 'start', { operation });
  }

  /**
   * Start a step within an operation
   */
  startStep(operationId: string, stepId: string): void {
    const operation = this.operations.get(operationId);
    if (!operation) {
      throw new Error(`Operation ${operationId} not found`);
    }

    const step = operation.steps.find(s => s.id === stepId);
    if (!step) {
      throw new Error(`Step ${stepId} not found in operation ${operationId}`);
    }

    step.status = 'in_progress';
    step.startTime = Date.now();
    operation.currentStep = stepId;
    
    this.updateOperationProgress(operationId);
    this.emitEvent(operationId, 'step_start', { step });
  }

  /**
   * Update progress for a step
   */
  updateStepProgress(operationId: string, stepId: string, progress: number, metadata?: any): void {
    const operation = this.operations.get(operationId);
    if (!operation) {
      throw new Error(`Operation ${operationId} not found`);
    }

    const step = operation.steps.find(s => s.id === stepId);
    if (!step) {
      throw new Error(`Step ${stepId} not found in operation ${operationId}`);
    }

    step.progress = Math.min(100, Math.max(0, progress));
    if (metadata) {
      step.metadata = { ...step.metadata, ...metadata };
    }

    this.updateOperationProgress(operationId);
    this.emitEvent(operationId, 'step_progress', { step, progress });
  }

  /**
   * Complete a step
   */
  completeStep(operationId: string, stepId: string, metadata?: any): void {
    const operation = this.operations.get(operationId);
    if (!operation) {
      throw new Error(`Operation ${operationId} not found`);
    }

    const step = operation.steps.find(s => s.id === stepId);
    if (!step) {
      throw new Error(`Step ${stepId} not found in operation ${operationId}`);
    }

    step.status = 'completed';
    step.progress = 100;
    step.endTime = Date.now();
    step.duration = step.endTime - (step.startTime || step.endTime);
    
    if (metadata) {
      step.metadata = { ...step.metadata, ...metadata };
    }

    this.updateOperationProgress(operationId);
    this.emitEvent(operationId, 'step_complete', { step });
  }

  /**
   * Mark a step as failed
   */
  failStep(operationId: string, stepId: string, error: string): void {
    const operation = this.operations.get(operationId);
    if (!operation) {
      throw new Error(`Operation ${operationId} not found`);
    }

    const step = operation.steps.find(s => s.id === stepId);
    if (!step) {
      throw new Error(`Step ${stepId} not found in operation ${operationId}`);
    }

    step.status = 'error';
    step.endTime = Date.now();
    step.duration = step.endTime - (step.startTime || step.endTime);
    step.error = error;

    this.emitEvent(operationId, 'error', { step, error });
  }

  /**
   * Skip a step
   */
  skipStep(operationId: string, stepId: string, reason?: string): void {
    const operation = this.operations.get(operationId);
    if (!operation) {
      throw new Error(`Operation ${operationId} not found`);
    }

    const step = operation.steps.find(s => s.id === stepId);
    if (!step) {
      throw new Error(`Step ${stepId} not found in operation ${operationId}`);
    }

    step.status = 'skipped';
    step.progress = 100;
    step.endTime = Date.now();
    
    if (reason) {
      step.metadata = { ...step.metadata, skipReason: reason };
    }

    this.updateOperationProgress(operationId);
  }

  /**
   * Update overall operation progress based on steps
   */
  private updateOperationProgress(operationId: string): void {
    const operation = this.operations.get(operationId);
    if (!operation || operation.steps.length === 0) {
      return;
    }

    const totalSteps = operation.steps.length;
    const completedSteps = operation.steps.filter(s => s.status === 'completed' || s.status === 'skipped').length;
    const inProgressSteps = operation.steps.filter(s => s.status === 'in_progress');
    
    let progress = (completedSteps / totalSteps) * 100;
    
    // Add progress from currently running step
    if (inProgressSteps.length > 0) {
      const stepProgress = inProgressSteps.reduce((sum, step) => sum + step.progress, 0) / inProgressSteps.length;
      progress += (stepProgress / totalSteps);
    }

    operation.progress = Math.min(100, Math.max(0, progress));
    
    // Update processed items count if available
    if (operation.metadata.totalItems) {
      operation.metadata.processedItems = Math.floor((operation.progress / 100) * operation.metadata.totalItems);
    }

    this.emitEvent(operationId, 'progress', {
      progress: operation.progress,
      processedItems: operation.metadata.processedItems
    });
  }

  /**
   * Complete an operation
   */
  completeOperation(operationId: string, metadata?: any): void {
    const operation = this.operations.get(operationId);
    if (!operation) {
      throw new Error(`Operation ${operationId} not found`);
    }

    operation.status = 'completed';
    operation.progress = 100;
    operation.endTime = Date.now();
    operation.duration = operation.endTime - operation.startTime;
    operation.currentStep = undefined;
    
    if (metadata) {
      operation.metadata = { ...operation.metadata, ...metadata };
    }

    // Complete any remaining in-progress steps
    operation.steps.forEach(step => {
      if (step.status === 'in_progress') {
        step.status = 'completed';
        step.progress = 100;
        step.endTime = operation.endTime;
        if (step.endTime) {
          step.duration = step.endTime - (step.startTime || step.endTime);
        }
      }
    });

    this.emitEvent(operationId, 'complete', { operation });
  }

  /**
   * Fail an operation
   */
  failOperation(operationId: string, error: string): void {
    const operation = this.operations.get(operationId);
    if (!operation) {
      throw new Error(`Operation ${operationId} not found`);
    }

    operation.status = 'error';
    operation.endTime = Date.now();
    operation.duration = operation.endTime - operation.startTime;
    operation.error = error;
    operation.currentStep = undefined;

    this.emitEvent(operationId, 'error', { operation, error });
  }

  /**
   * Cancel an operation
   */
  cancelOperation(operationId: string, reason?: string): void {
    const operation = this.operations.get(operationId);
    if (!operation) {
      throw new Error(`Operation ${operationId} not found`);
    }

    if (!operation.cancellable) {
      throw new Error(`Operation ${operationId} is not cancellable`);
    }

    operation.status = 'cancelled';
    operation.endTime = Date.now();
    operation.duration = operation.endTime - operation.startTime;
    operation.cancelled = true;
    operation.currentStep = undefined;

    if (reason) {
      operation.metadata = { ...operation.metadata, cancelReason: reason };
    }

    this.emitEvent(operationId, 'cancel', { operation, reason });
  }

  /**
   * Get operation by ID
   */
  getOperation(operationId: string): ProgressOperation | undefined {
    return this.operations.get(operationId);
  }

  /**
   * Get all operations
   */
  getAllOperations(): ProgressOperation[] {
    return Array.from(this.operations.values());
  }

  /**
   * Get operations by status
   */
  getOperationsByStatus(status: ProgressOperation['status']): ProgressOperation[] {
    return Array.from(this.operations.values()).filter(op => op.status === status);
  }

  /**
   * Get active operations (pending or in_progress)
   */
  getActiveOperations(): ProgressOperation[] {
    return Array.from(this.operations.values()).filter(op =>
      op.status === 'pending' || op.status === 'in_progress'
    );
  }

  /**
   * Clean up completed operations older than specified time
   */
  cleanup(olderThanMs: number = 3600000): string[] { // Default 1 hour
    const cutoff = Date.now() - olderThanMs;
    const toRemove: string[] = [];

    this.operations.forEach((operation, id) => {
      if (
        (operation.status === 'completed' || operation.status === 'error' || operation.status === 'cancelled') &&
        operation.endTime &&
        operation.endTime < cutoff
      ) {
        toRemove.push(id);
      }
    });

    toRemove.forEach(id => {
      this.operations.delete(id);
      this.listeners.delete(id);
    });

    return toRemove;
  }

  /**
   * Add event listener for specific operation
   */
  addListener(operationId: string, callback: ProgressCallback): void {
    if (!this.listeners.has(operationId)) {
      this.listeners.set(operationId, []);
    }
    this.listeners.get(operationId)!.push(callback);
  }

  /**
   * Add global event listener for all operations
   */
  addGlobalListener(callback: ProgressCallback): void {
    this.globalListeners.push(callback);
  }

  /**
   * Remove event listener
   */
  removeListener(operationId: string, callback: ProgressCallback): void {
    const listeners = this.listeners.get(operationId);
    if (listeners) {
      const index = listeners.indexOf(callback);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    }
  }

  /**
   * Remove global event listener
   */
  removeGlobalListener(callback: ProgressCallback): void {
    const index = this.globalListeners.indexOf(callback);
    if (index > -1) {
      this.globalListeners.splice(index, 1);
    }
  }

  /**
   * Emit progress event
   */
  private emitEvent(operationId: string, type: ProgressEvent['type'], data: any): void {
    const event: ProgressEvent = {
      operationId,
      type,
      data,
      timestamp: Date.now()
    };

    // Notify operation-specific listeners
    const listeners = this.listeners.get(operationId);
    if (listeners) {
      listeners.forEach(callback => {
        try {
          callback(event);
        } catch (error) {
          console.error('Error in progress listener:', error);
        }
      });
    }

    // Notify global listeners
    this.globalListeners.forEach(callback => {
      try {
        callback(event);
      } catch (error) {
        console.error('Error in global progress listener:', error);
      }
    });
  }

  /**
   * Get operation statistics
   */
  getStats(): {
    total: number;
    pending: number;
    inProgress: number;
    completed: number;
    error: number;
    cancelled: number;
    averageDuration: number;
  } {
    const operations = Array.from(this.operations.values());
    
    return {
      total: operations.length,
      pending: operations.filter(op => op.status === 'pending').length,
      inProgress: operations.filter(op => op.status === 'in_progress').length,
      completed: operations.filter(op => op.status === 'completed').length,
      error: operations.filter(op => op.status === 'error').length,
      cancelled: operations.filter(op => op.status === 'cancelled').length,
      averageDuration: operations
        .filter(op => op.duration !== undefined)
        .reduce((sum, op) => sum + (op.duration || 0), 0) /
        operations.filter(op => op.duration !== undefined).length || 0
    };
  }
}

// Singleton instance
export const progressTracker = new ProgressTracker();

// Convenience functions for common operations
export function createDocumentIngestionOperation(config: {
  sessionId: string;
  documentId: string;
  fileName: string;
  totalChunks?: number;
}): ProgressOperation {
  return progressTracker.createOperation({
    type: 'document_ingestion',
    title: `Processing ${config.fileName}`,
    description: 'Ingesting document and processing embeddings',
    cancellable: true,
    metadata: {
      sessionId: config.sessionId,
      documentId: config.documentId,
      fileName: config.fileName,
      totalItems: config.totalChunks
    }
  });
}

export function createVectorSearchOperation(config: {
  sessionId: string;
  query: string;
}): ProgressOperation {
  return progressTracker.createOperation({
    type: 'vector_search',
    title: 'Searching documents',
    description: `Finding relevant content for: "${config.query.substring(0, 50)}..."`,
    cancellable: false,
    metadata: {
      sessionId: config.sessionId,
      query: config.query
    }
  });
}

export function createChatGenerationOperation(config: {
  sessionId: string;
  messageCount?: number;
}): ProgressOperation {
  return progressTracker.createOperation({
    type: 'chat_generation',
    title: 'Generating response',
    description: 'Creating AI response with citations',
    cancellable: true,
    metadata: {
      sessionId: config.sessionId,
      messageCount: config.messageCount
    }
  });
}
    
