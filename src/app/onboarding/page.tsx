'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
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

export default function OnboardingPage() {
  const router = useRouter();
  const [currentSlide, setCurrentSlide] = useState(0);
  const [isCompleting, setIsCompleting] = useState(false);

  // Check if already onboarded
  useEffect(() => {
    const onboarded = localStorage.getItem('onboarding_completed');
    if (onboarded === 'true') {
      router.replace('/');
    }
  }, [router]);

  const handleComplete = () => {
    setIsCompleting(true);
    localStorage.setItem('onboarding_completed', 'true');
    router.push('/');
  };

  const handleNextSlide = () => {
    window.scrollTo(0, 0);
    if (currentSlide < carouselSlides.length - 1) {
      setCurrentSlide(currentSlide + 1);
      return;
    }

    handleComplete();
  };

  const handlePrevSlide = () => {
    window.scrollTo(0, 0);
    if (currentSlide > 0) {
      setCurrentSlide(currentSlide - 1);
    }
  };

  const currentSlideData = carouselSlides[currentSlide];

  return (
    <div className="min-h-screen bg-gray-900 flex flex-col overflow-hidden">
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
            <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-gray-900/80 to-transparent" />
          </div>

          {/* Navigation Buttons */}
          <div className="flex gap-4">
            {currentSlide > 0 && (
              <button
                className="flex-1 py-3 px-6 rounded-xl border-2 border-white/50 text-white font-semibold hover:bg-white/20 transition-all"
                onClick={handlePrevSlide}
                disabled={isCompleting}
              >
                Back
              </button>
            )}
            <button
              className={clsx(
                'flex-1 py-3 px-6 rounded-xl bg-white text-gray-900 font-semibold hover:bg-gray-100 transition-all shadow-lg disabled:opacity-60',
                currentSlide === 0 && 'w-full'
              )}
              onClick={handleNextSlide}
              disabled={isCompleting}
            >
              {currentSlide < carouselSlides.length - 1 ? 'Next' : isCompleting ? 'Starting...' : 'Get Started'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
