import React, { useState, useEffect } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { useSessionStore } from '../../store';
import { Session } from '../../types';

interface RenameSessionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  session: Session | null;
  onRename?: (session: Session) => void;
}

export const RenameSessionDialog: React.FC<RenameSessionDialogProps> = ({
  isOpen,
  onClose,
  session,
  onRename,
}) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  
  const { updateSession } = useSessionStore();

  // Reset form when session changes
  useEffect(() => {
    if (session) {
      setName(session.name);
      setDescription(session.description || '');
      setError('');
    }
  }, [session]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!name.trim()) {
      setError('Session name is required');
      return;
    }

    if (!session) {
      setError('No session selected');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      await updateSession(session.id, {
        name: name.trim(),
        description: description.trim() || undefined,
      });

      if (onRename) {
        onRename(session);
      }

      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to rename session');
    } finally {
      setIsLoading(false);
    }
  };

  const handleClose = () => {
    if (!isLoading) {
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
            Rename Session
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
            disabled={!name.trim() || !session}
            className="flex-1"
          >
            Rename Session
          </Button>
        </div>
      </form>
    </Modal>
  );
};

// Hook for managing rename session dialog
export const useRenameSessionDialog = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [session, setSession] = useState<Session | null>(null);

  const openDialog = (sessionToRename: Session) => {
    setSession(sessionToRename);
    setIsOpen(true);
  };

  const closeDialog = () => {
    setIsOpen(false);
    setSession(null);
  };

  const RenameSessionDialogComponent = () => (
    <RenameSessionDialog
      isOpen={isOpen}
      onClose={closeDialog}
      session={session}
    />
  );

  return {
    isOpen,
    session,
    openDialog,
    closeDialog,
    RenameSessionDialog: RenameSessionDialogComponent,
  };
};