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
  const [description, setDescription] = useState('');
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
        description: description.trim() || undefined,
      });

      if (onCreate) {
        onCreate(newSession);
      } else {
        router.push(`/session/${newSession.id}`);
      }

      // Reset form
      setName('');
      setDescription('');
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
      setDescription('');
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
            Create New Session
          </h2>
        </div>

        {/* Session Name */}
        <div>
          <Input
            label="Session Name"
            placeholder="Enter a name for this session"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            disabled={isLoading}
            autoFocus
          />
        </div>

        {/* Description */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Description (optional)
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Brief description of this session's purpose"
            rows={3}
            disabled={isLoading}
            className={`
              w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg
              bg-white dark:bg-gray-800
              text-gray-900 dark:text-gray-100
              placeholder-gray-500 dark:placeholder-gray-400
              focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
              disabled:opacity-50 disabled:cursor-not-allowed
              transition-colors duration-200
            `}
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
            Create Session
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