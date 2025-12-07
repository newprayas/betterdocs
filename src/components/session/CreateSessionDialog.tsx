import React, { useState } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { useSessionStore } from '../../store';
import { useRouter } from 'next/navigation';

interface CreateSessionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate?: (session: any) => void;
}

export const CreateSessionDialog: React.FC<CreateSessionDialogProps> = ({
  isOpen,
  onClose,
  onCreate,
}) => {
  const [name, setName] = useState('');

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const { createSession } = useSessionStore();
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim()) {
      setError('Session name is required');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      const newSession = await createSession({
        name: name.trim(),

      });

      if (onCreate) {
        onCreate(newSession);
      }
      // Session created - no auto-navigation

      // Reset form
      setName('');

      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to create session');
    } finally {
      setIsLoading(false);
    }
  };

  const handleClose = () => {
    if (!isLoading) {
      setName('');
      setName('');
      setError('');
      onClose();
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      size="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
            Create New Chat
          </h2>
        </div>

        {/* Session Name */}
        <div>
          <Input
            label="Subject Name"
            placeholder="Subject name like : MEDICINE, SURGERY etc"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            disabled={isLoading}
            autoFocus
          />
        </div>




        {/* Error Message */}
        {error && (
          <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3 pt-4">
          <Button
            type="button"
            variant="outline"
            onClick={handleClose}
            disabled={isLoading}
            className="flex-1"
          >
            Cancel
          </Button>

          <Button
            type="submit"
            loading={isLoading}
            disabled={!name.trim()}
            className="flex-1"
          >
            Create Chat
          </Button>
        </div>
      </form>
    </Modal>
  );
};

// Hook for managing create session dialog
export const useCreateSessionDialog = () => {
  const [isOpen, setIsOpen] = useState(false);

  const openDialog = () => setIsOpen(true);
  const closeDialog = () => setIsOpen(false);

  const CreateSessionDialogComponent = () => (
    <CreateSessionDialog
      isOpen={isOpen}
      onClose={closeDialog}
    />
  );

  return {
    isOpen,
    openDialog,
    closeDialog,
    CreateSessionDialog: CreateSessionDialogComponent,
  };
};