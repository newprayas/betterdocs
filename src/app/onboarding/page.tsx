'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSettingsStore } from '../../store';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Input } from '../../components/ui/Input';
import clsx from 'clsx';

// Define carousel slides data
const carouselSlides = [
  {
    id: 1,
    title: 'Chat with Medical Books',
    subtitle: 'Entire books, no limits!',
    description: 'Can read whole textbooks and ask questions directly. Get answers from your own trusted resources.',
    image: '/onboarding/Screenshot_2025-12-08-00-53-21-734_com.android.chrome.jpg',
    gradient: 'from-blue-600 to-indigo-700',
    iconBg: 'bg-blue-500',
    icon: (
      <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
      </svg>
    ),
  },
  {
    id: 2,
    title: 'Get Verified Answers with Sources',
    subtitle: 'Answers you can trust',
    description: 'Every response includes citations - book name, page number and even the exact paragraph - so you can verify information and trace it back to the source.',
    image: '/onboarding/Screenshot_2025-12-08-00-56-09-186_com.android.chrome.jpg',
    gradient: 'from-emerald-500 to-teal-600',
    iconBg: 'bg-emerald-500',
    icon: (
      <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    id: 3,
    title: 'Only TRUSTED answers',
    subtitle: 'From only the books you choose',
    description: 'Only answers from the books given to it - Answers you can fully trust. Say it with confidence if someone asks - you have all the sources!',
    image: '/onboarding/Screenshot_2025-12-08-00-59-03-643_com.android.chrome.jpg',
    gradient: 'from-pink-500 to-rose-600',
    iconBg: 'bg-pink-500',
    icon: (
      <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
    ),
  },
];

type OnboardingStep = 'carousel' | 'apiSetup';

export default function OnboardingPage() {
  const router = useRouter();
  const { updateSettings } = useSettingsStore();

  const [currentStep, setCurrentStep] = useState<OnboardingStep>('carousel');
  const [currentSlide, setCurrentSlide] = useState(0);
  const [apiKey, setApiKey] = useState('');
  const [isValidating, setIsValidating] = useState(false);
  const [validationError, setValidationError] = useState('');
  const [isCompleting, setIsCompleting] = useState(false);

  // Check if already onboarded
  useEffect(() => {
    const onboarded = localStorage.getItem('onboarding_completed');
    if (onboarded === 'true') {
      router.replace('/');
    }
  }, [router]);

  const handleNextSlide = () => {
    window.scrollTo(0, 0);
    if (currentSlide < carouselSlides.length - 1) {
      setCurrentSlide(currentSlide + 1);
    } else {
      // Move to API setup
      setCurrentStep('apiSetup');
    }
  };

  const handlePrevSlide = () => {
    window.scrollTo(0, 0);
    if (currentSlide > 0) {
      setCurrentSlide(currentSlide - 1);
    }
  };



  const handleBackToCarousel = () => {
    window.scrollTo(0, 0);
    setCurrentStep('carousel');
    setCurrentSlide(carouselSlides.length - 1);
  };

  const handleComplete = async () => {
    if (!apiKey.trim()) {
      setValidationError('Please enter an API key to continue');
      return;
    }

    setIsValidating(true);
    setValidationError('');

    try {
      // Validate Groq API key
      const { groqService } = await import('../../services/groq/groqService');
      const isValid = await groqService.validateApiKey(apiKey);

      if (!isValid) {
        setValidationError('Invalid API key. Please check your key and try again.');
        setIsValidating(false);
        return;
      }

      setIsCompleting(true);
      await updateSettings({
        groqApiKey: apiKey,
      });

      // Mark onboarding as complete
      localStorage.setItem('onboarding_completed', 'true');

      router.push('/');
    } catch (error) {
      setValidationError('Failed to validate API key. Please check your connection and try again.');
    } finally {
      setIsValidating(false);
      setIsCompleting(false);
    }
  };

  const currentSlideData = carouselSlides[currentSlide];

  return (
    <div className="min-h-screen bg-gray-900 flex flex-col overflow-hidden">
      {currentStep === 'carousel' ? (
        // --- CAROUSEL VIEW ---
        <div className="flex-1 flex flex-col relative">
          {/* Background Gradient */}
          <div className={`absolute inset-0 bg-gradient-to-br ${currentSlideData.gradient} opacity-20 transition-all duration-700`} />

          {/* Content */}
          <div className="relative flex-1 flex flex-col px-6 py-8 max-w-lg mx-auto w-full">
            {/* Header with progress indicators */}
            <div className="flex items-center justify-between mb-6">
              <div className="flex gap-2">
                {carouselSlides.map((_, index) => (
                  <div
                    key={index}
                    className={clsx(
                      'h-1.5 rounded-full transition-all duration-300',
                      index === currentSlide
                        ? 'w-8 bg-white'
                        : index < currentSlide
                          ? 'w-4 bg-white/60'
                          : 'w-4 bg-white/30'
                    )}
                  />
                ))}
              </div>

            </div>

            {/* Icon Badge */}
            <div className={`w-16 h-16 ${currentSlideData.iconBg} rounded-2xl flex items-center justify-center mb-6 shadow-lg`}>
              {currentSlideData.icon}
            </div>

            {/* Title & Subtitle */}
            <h1 className="text-3xl font-bold text-white mb-2">
              {currentSlideData.title}
            </h1>
            <p className="text-lg text-white/80 font-medium mb-3">
              {currentSlideData.subtitle}
            </p>
            <p className="text-base text-white/60 mb-6">
              {currentSlideData.description}
            </p>

            {/* Image Mockup */}
            <div className="flex-1 relative rounded-2xl overflow-hidden shadow-2xl border border-white/10 bg-gray-800 mb-6">
              <img
                src={currentSlideData.image}
                alt={currentSlideData.title}
                className="w-full h-full object-cover object-top"
              />
              {/* Gradient overlay at bottom */}
              <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-gray-900/80 to-transparent" />
            </div>

            {/* Navigation Buttons */}
            <div className="flex gap-4">
              {currentSlide > 0 && (
                <button
                  className="flex-1 py-3 px-6 rounded-xl border-2 border-white/50 text-white font-semibold hover:bg-white/20 transition-all"
                  onClick={handlePrevSlide}
                >
                  Back
                </button>
              )}
              <button
                className={clsx(
                  'flex-1 py-3 px-6 rounded-xl bg-white text-gray-900 font-semibold hover:bg-gray-100 transition-all shadow-lg',
                  currentSlide === 0 && 'w-full'
                )}
                onClick={handleNextSlide}
              >
                {currentSlide < carouselSlides.length - 1 ? 'Next' : 'Get Started'}
              </button>
            </div>
          </div>
        </div>
      ) : (
        // --- API SETUP VIEW ---
        <div className="flex-1 flex flex-col px-6 py-8 max-w-lg mx-auto w-full overflow-y-auto">
          {/* Header */}
          <button
            onClick={handleBackToCarousel}
            className="flex items-center gap-2 text-white/70 hover:text-white mb-6 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back
          </button>

          {/* Icon */}
          <div className="w-16 h-16 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-2xl flex items-center justify-center mb-6 shadow-lg">
            <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
            </svg>
          </div>

          {/* Title */}
          <h1 className="text-2xl font-bold text-white mb-2">
            One Quick Setup
          </h1>
          <p className="text-white/60 mb-6">
            Before we start, we need to set up your AI key. It takes less than 30 seconds!
          </p>

          {/* Explanation Card */}
          <Card className="p-4 bg-blue-500/10 border-blue-500/30 mb-6">
            <h3 className="font-semibold text-blue-300 mb-2 flex items-center gap-2">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              What's an API Key?
            </h3>
            <p className="text-sm text-blue-200/80">
              Think of it as a password that lets Meddy talk to the books. It's free, takes seconds to get, and you only need to do this once. Your key is stored safely on your device.
            </p>
          </Card>

          {/* Get API Key Link */}
          <a
            href="https://console.groq.com/keys"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 w-full py-3 px-4 mb-6 rounded-xl bg-gradient-to-r from-blue-500 to-indigo-600 text-white font-semibold hover:from-blue-600 hover:to-indigo-700 transition-all shadow-lg"
          >
            Get Your Free API Key
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>

          {/* API Key Input */}
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-white/80 mb-2">
                Paste your API Key here
              </label>
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setValidationError('');
                }}
                placeholder="gsk_..."
                className={clsx(
                  'bg-gray-800 border-gray-700 text-white placeholder-gray-500',
                  validationError && 'border-red-500 focus:border-red-500 focus:ring-red-500'
                )}
              />
              {validationError && (
                <p className="text-sm text-red-400 mt-2 flex items-center gap-1">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {validationError}
                </p>
              )}
            </div>
          </div>

          {/* Complete Button */}
          <div className="mt-8">
            <Button
              onClick={handleComplete}
              disabled={isValidating || isCompleting || !apiKey.trim()}
              loading={isValidating || isCompleting}
              className="w-full py-3 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white font-semibold text-lg shadow-lg disabled:opacity-50"
            >
              {isValidating ? 'Validating...' : isCompleting ? 'Setting up...' : 'Complete Setup'}
            </Button>
          </div>

          {/* Footer note */}
          <p className="text-center text-white/40 text-xs mt-6">
            This is a one-time setup. You can change your API key later in Settings.
          </p>
        </div>
      )}
    </div>
  );
}