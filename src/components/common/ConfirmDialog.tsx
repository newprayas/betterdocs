import React from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';

interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'warning' | 'info';
  isLoading?: boolean;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'info',
  isLoading = false,
}) => {
  const handleConfirm = () => {
    console.log('🔍 ConfirmDialog: handleConfirm called', {
      isLoading,
      hasOnConfirm: typeof onConfirm === 'function',
      title,
      timestamp: new Date().toISOString()
    });
    // Don't call onClose here - let the useConfirmDialog hook handle it
    // This prevents premature closing before async operations complete
    console.log('🔍 ConfirmDialog: About to call onConfirm callback');
    try {
      const result = onConfirm();
      console.log('🔍 ConfirmDialog: onConfirm callback returned', {
        result,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('❌ ConfirmDialog: Error calling onConfirm callback', {
        error: error instanceof Error ? error.message : error,
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString()
      });
    }
    console.log('✅ ConfirmDialog: handleConfirm completed');
  };

  const getVariantClasses = () => {
    switch (variant) {
      case 'danger':
        return {
          icon: 'text-red-500',
          button: 'danger',
        };
      case 'warning':
        return {
          icon: 'text-yellow-500',
          button: 'warning',
        };
      default:
        return {
          icon: 'text-blue-500',
          button: 'primary',
        };
    }
  };

  const variantClasses = getVariantClasses();

  const getIcon = () => {
    switch (variant) {
      case 'danger':
        return (
          <svg
            className="h-6 w-6 text-red-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.732-.833-2.5 0L4.268 18.5c-.77.833.192 2.5 1.732 2.5z"
            />
          </svg>
        );
      case 'warning':
        return (
          <svg
            className="h-6 w-6 text-yellow-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.732-.833-2.5 0L4.268 18.5c-.77.833.192 2.5 1.732 2.5z"
            />
          </svg>
        );
      default:
        return (
          <svg
            className="h-6 w-6 text-blue-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        );
    }
  };

  // console.log('🔍 ConfirmDialog: About to render Modal', {
  //   isOpen,
  //   title,
  //   message,
  //   variant,
  //   isLoading
  // });

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
    >
      <div className="text-center">
        <div className="mx-auto mb-4">
          {getIcon()}
        </div>
        
        <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
          {title}
        </h3>
        
        <p className="text-gray-600 dark:text-gray-300 mb-6">
          {message}
        </p>
        
        <div className="flex gap-3 justify-center">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={isLoading}
          >
            {cancelText}
          </Button>
          
          <Button
            variant={variantClasses.button as any}
            onClick={() => {
              console.log('🔍 ConfirmDialog: Confirm button clicked', {
                isLoading,
                title,
                confirmText
              });
              handleConfirm();
            }}
            disabled={isLoading}
            loading={isLoading}
          >
            {confirmText}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

// Hook for showing confirmation dialogs
export const useConfirmDialog = () => {
  const [dialog, setDialog] = React.useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    resolve?: (value: boolean) => void;
    variant?: 'danger' | 'warning' | 'info';
    confirmText?: string;
    cancelText?: string;
  }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
  });

  const [isLoading, setIsLoading] = React.useState(false);

  const confirm = (options: {
    title: string;
    message: string;
    onConfirm: () => void | Promise<void> | Promise<boolean>;
    variant?: 'danger' | 'warning' | 'info';
    confirmText?: string;
    cancelText?: string;
  }): Promise<boolean> => {
    console.log('🔍 useConfirmDialog: confirm called with options:', {
      title: options.title,
      variant: options.variant,
      hasOnConfirm: typeof options.onConfirm === 'function'
    });
    
    return new Promise<boolean>((resolve) => {
      console.log('🔍 useConfirmDialog: Creating new Promise for confirmation');
      setDialog({
        isOpen: true,
        ...options,
        resolve,
      });
      console.log('✅ useConfirmDialog: Dialog state set to open with resolve function');
    });
  };

  const handleClose = () => {
    console.log('🔍 useConfirmDialog: handleClose called, resolving with false and closing dialog');
    if (dialog.resolve) {
      dialog.resolve(false);
    }
    setDialog(prev => ({ ...prev, isOpen: false }));
    console.log('✅ useConfirmDialog: Dialog state set to closed');
  };

  const handleConfirm = async () => {
    console.log('🔍 useConfirmDialog: handleConfirm started', {
      dialogTitle: dialog.title,
      hasOnConfirm: typeof dialog.onConfirm === 'function',
      isOpen: dialog.isOpen,
      hasResolve: typeof dialog.resolve === 'function',
      timestamp: new Date().toISOString()
    });
    setIsLoading(true);
    try {
      console.log('🔍 useConfirmDialog: About to call dialog.onConfirm');
      const startTime = Date.now();
      const result = await dialog.onConfirm();
      const endTime = Date.now();
      console.log('✅ useConfirmDialog: dialog.onConfirm completed successfully', {
        result,
        duration: endTime - startTime,
        timestamp: new Date().toISOString()
      });
      
      // Resolve with true after successful confirmation
      if (dialog.resolve) {
        console.log('🔍 useConfirmDialog: Resolving Promise with true (confirmed)', {
          timestamp: new Date().toISOString()
        });
        dialog.resolve(true);
      } else {
        console.error('❌ useConfirmDialog: No resolve function available!');
      }
    } catch (error) {
      console.error('❌ useConfirmDialog: Error in dialog.onConfirm:', {
        error: error instanceof Error ? error.message : error,
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString()
      });
      
      // Still resolve with false on error to close the dialog
      if (dialog.resolve) {
        console.log('🔍 useConfirmDialog: Resolving Promise with false (error occurred)', {
          timestamp: new Date().toISOString()
        });
        dialog.resolve(false);
      } else {
        console.error('❌ useConfirmDialog: No resolve function available during error handling!');
      }
    } finally {
      console.log('🔍 useConfirmDialog: Cleaning up - setting isLoading to false and closing dialog', {
        timestamp: new Date().toISOString()
      });
      setIsLoading(false);
      setDialog(prev => ({ ...prev, isOpen: false }));
    }
  };

  const ConfirmDialogComponent = () => (
    <ConfirmDialog
      isOpen={dialog.isOpen}
      onClose={handleClose}
      onConfirm={handleConfirm}
      title={dialog.title}
      message={dialog.message}
      variant={dialog.variant}
      confirmText={dialog.confirmText}
      cancelText={dialog.cancelText}
      isLoading={isLoading}
    />
  );

  return {
    confirm,
    ConfirmDialog: ConfirmDialogComponent,
  };
};