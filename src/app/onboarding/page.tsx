'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSettingsStore } from '../../store';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Input } from '../../components/ui/Input';
import { Header } from '../../components/layout/Header';
import clsx from 'clsx';

export default function OnboardingPage() {
  const router = useRouter();
  const { updateSettings, validateApiKey } = useSettingsStore();
  
  const [step, setStep] = useState(1);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('gemini-1.5-flash');
  const [isValidating, setIsValidating] = useState(false);
  const [validationError, setValidationError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const totalSteps = 3;

  const handleNext = async () => {
    if (step === 2) {
      // Validate API key before proceeding
      if (!apiKey.trim()) {
        setValidationError('Please enter an API key');
        return;
      }

      setIsValidating(true);
      setValidationError('');

      try {
        const error = await validateApiKey(apiKey);
        if (error) {
          setValidationError(error);
          return;
        }
        setStep(step + 1);
      } catch (error) {
        setValidationError('Failed to validate API key. Please check your connection and try again.');
      } finally {
        setIsValidating(false);
      }
    } else {
      setStep(step + 1);
    }
  };

  const handleBack = () => {
    setStep(step - 1);
  };

  const handleComplete = async () => {
    setIsLoading(true);
    try {
      await updateSettings({
        geminiApiKey: apiKey,
        model: model,
      });
      router.push('/');
    } catch (error) {
      console.error('Failed to save settings:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const renderStep = () => {
    switch (step) {
      case 1:
        return (
          <div className="text-center space-y-6">
            <div className="mx-auto w-16 h-16 bg-blue-100 dark:bg-blue-900 rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            
            <div>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
                Welcome to Meddy
              </h2>
              <p className="text-gray-600 dark:text-gray-300 max-w-md mx-auto">
                Your private RAG (Retrieval-Augmented Generation) chat application for documents. 
                Chat with your documents using AI-powered search and context retrieval.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-2xl mx-auto">
              <Card className="p-4 text-center">
                <div className="w-12 h-12 bg-green-100 dark:bg-green-900 rounded-full flex items-center justify-center mx-auto mb-3">
                  <svg className="w-6 h-6 text-green-600 dark:text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
                <h3 className="font-semibold text-gray-900 dark:text-white mb-2">Upload Documents</h3>
                <p className="text-sm text-gray-600 dark:text-gray-300">Import PDF, DOC, TXT files for AI analysis</p>
              </Card>

              <Card className="p-4 text-center">
                <div className="w-12 h-12 bg-blue-100 dark:bg-blue-900 rounded-full flex items-center justify-center mx-auto mb-3">
                  <svg className="w-6 h-6 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                </div>
                <h3 className="font-semibold text-gray-900 dark:text-white mb-2">Chat & Query</h3>
                <p className="text-sm text-gray-600 dark:text-gray-300">Ask questions and get AI-powered responses</p>
              </Card>

              <Card className="p-4 text-center">
                <div className="w-12 h-12 bg-purple-100 dark:bg-purple-900 rounded-full flex items-center justify-center mx-auto mb-3">
                  <svg className="w-6 h-6 text-purple-600 dark:text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                  </svg>
                </div>
                <h3 className="font-semibold text-gray-900 dark:text-white mb-2">Get Citations</h3>
                <p className="text-sm text-gray-600 dark:text-gray-300">See source documents for every response</p>
              </Card>
            </div>
          </div>
        );

      case 2:
        return (
          <div className="space-y-6">
            <div className="text-center">
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
                Set Up API Key
              </h2>
              <p className="text-gray-600 dark:text-gray-300">
                Get your free Gemini API key from Google AI Studio to enable AI chat functionality
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Gemini API Key
                </label>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    setValidationError('');
                  }}
                  placeholder="AIza..."
                  className={clsx(
                    validationError && 'border-red-300 focus:border-red-500 focus:ring-red-500'
                  )}
                />
                {validationError && (
                  <p className="text-sm text-red-600 dark:text-red-400 mt-1">{validationError}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Model
                </label>
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-white"
                >
                  <option value="gemini-1.5-flash">Gemini 1.5 Flash (Fast, Cost-effective)</option>
                  <option value="gemini-1.5-pro">Gemini 1.5 Pro (Advanced)</option>
                  <option value="gemini-pro">Gemini Pro (Legacy)</option>
                </select>
              </div>

              <Card className="p-4 bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800">
                <h3 className="font-semibold text-blue-900 dark:text-blue-100 mb-2">
                  How to get your API key:
                </h3>
                <ol className="text-sm text-blue-800 dark:text-blue-200 space-y-1 list-decimal list-inside">
                  <li>Visit <a href="https://makersuite.google.com/app/apikey" target="_blank" rel="noopener noreferrer" className="underline hover:no-underline">Google AI Studio</a></li>
                  <li>Sign in with your Google account</li>
                  <li>Click "Create API Key"</li>
                  <li>Copy your API key and paste it above</li>
                </ol>
              </Card>
            </div>
          </div>
        );

      case 3:
        return (
          <div className="text-center space-y-6">
            <div className="mx-auto w-16 h-16 bg-green-100 dark:bg-green-900 rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-green-600 dark:text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            
            <div>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
                You're All Set!
              </h2>
              <p className="text-gray-600 dark:text-gray-300 max-w-md mx-auto">
                Your Meddy account is configured and ready to use. Start by creating your first chat session and uploading some documents.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-lg mx-auto">
              <Card className="p-4">
                <h3 className="font-semibold text-gray-900 dark:text-white mb-2">Quick Start Tips</h3>
                <ul className="text-sm text-gray-600 dark:text-gray-300 text-left space-y-1">
                  <li>• Create a session for each topic</li>
                  <li>• Upload relevant documents</li>
                  <li>• Ask specific questions</li>
                  <li>• Check citations for sources</li>
                </ul>
              </Card>

              <Card className="p-4">
                <h3 className="font-semibold text-gray-900 dark:text-white mb-2">Privacy First</h3>
                <ul className="text-sm text-gray-600 dark:text-gray-300 text-left space-y-1">
                  <li>• All data stored locally</li>
                  <li>• No cloud dependencies</li>
                  <li>• Your documents stay private</li>
                  <li>• Works offline after setup</li>
                </ul>
              </Card>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col">
      <Header />
      
      <main className="flex-1 container mx-auto px-4 py-8 max-w-4xl overflow-y-auto">
        {/* Progress Bar */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-600 dark:text-gray-300">
              Step {step} of {totalSteps}
            </span>
            <span className="text-sm font-medium text-gray-600 dark:text-gray-300">
              {Math.round((step / totalSteps) * 100)}% Complete
            </span>
          </div>
          <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
            <div
              className="bg-blue-500 h-2 rounded-full transition-all duration-300"
              style={{ width: `${(step / totalSteps) * 100}%` }}
            />
          </div>
        </div>

        {/* Content */}
        <Card className="p-8">
          {renderStep()}
        </Card>

        {/* Navigation */}
        <div className="flex justify-between items-center mt-8">
          <Button
            variant="outline"
            onClick={step === 1 ? () => router.push('/') : handleBack}
            disabled={isLoading}
          >
            {step === 1 ? 'Skip' : 'Back'}
          </Button>

          {step < totalSteps ? (
            <Button
              onClick={handleNext}
              disabled={isValidating || (step === 2 && !apiKey.trim())}
              loading={isValidating}
            >
              {step === 2 ? 'Validate & Continue' : 'Next'}
            </Button>
          ) : (
            <Button
              onClick={handleComplete}
              disabled={isLoading}
              loading={isLoading}
            >
              Get Started
            </Button>
          )}
        </div>
      </main>
    </div>
  );
}