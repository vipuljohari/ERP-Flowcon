
import React, { useState, useEffect, useRef } from 'react';
import { Part, Sale } from '../types';
import { getInventoryInsights, chatWithAI } from '../services/gemini';

interface AIAnalystProps {
  parts: Part[];
  sales: Sale[];
}

const AIAnalyst: React.FC<AIAnalystProps> = ({ parts, sales }) => {
  const [insight, setInsight] = useState<string>('');
  const [loadingInsight, setLoadingInsight] = useState(false);
  const [messages, setMessages] = useState<{ role: 'user' | 'model'; content: string }[]>([]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const fetchInsights = async () => {
    setLoadingInsight(true);
    const data = await getInventoryInsights(parts, sales);
    setInsight(data || "No insights found.");
    setLoadingInsight(false);
  };

  useEffect(() => {
    fetchInsights();
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    const userMessage = input.trim();
    setMessages(prev => [...prev, { role: 'user', content: userMessage }]);
    setInput('');
    setIsTyping(true);

    const response = await chatWithAI(userMessage, parts, messages);
    setMessages(prev => [...prev, { role: 'model', content: response || "Error processing request." }]);
    setIsTyping(false);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-[calc(100vh-140px)]">
      {/* Strategic Insights Panel */}
      <div className="lg:col-span-1 flex flex-col gap-6">
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 flex-1 overflow-y-auto">
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-xl font-bold text-slate-800 flex items-center gap-2">
              <span>💡</span> Strategic Insights
            </h3>
            <button 
              onClick={fetchInsights}
              disabled={loadingInsight}
              className="text-blue-600 hover:text-blue-700 disabled:opacity-50"
            >
              <svg className={`w-5 h-5 ${loadingInsight ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
              </svg>
            </button>
          </div>

          {loadingInsight ? (
            <div className="space-y-4">
              <div className="h-4 bg-slate-100 animate-pulse rounded w-3/4"></div>
              <div className="h-4 bg-slate-100 animate-pulse rounded w-1/2"></div>
              <div className="h-4 bg-slate-100 animate-pulse rounded w-full"></div>
              <div className="h-4 bg-slate-100 animate-pulse rounded w-2/3"></div>
            </div>
          ) : (
            <div className="prose prose-sm text-slate-600">
              <div className="whitespace-pre-wrap leading-relaxed">{insight}</div>
            </div>
          )}
        </div>

        <div className="bg-gradient-to-br from-blue-600 to-indigo-700 p-6 rounded-2xl shadow-lg text-white">
          <h4 className="font-bold mb-2">Demand Forecast</h4>
          <p className="text-sm opacity-90 mb-4">AI suggests restocking 'Timing Belts' as sales are trending up 22% this week.</p>
          <div className="bg-white/20 h-2 rounded-full overflow-hidden">
            <div className="bg-white h-full w-[80%]"></div>
          </div>
          <p className="text-[10px] mt-2 opacity-70">CONFIDENCE SCORE: 89%</p>
        </div>
      </div>

      {/* AI Chat Command Center */}
      <div className="lg:col-span-2 bg-slate-50 border border-slate-200 rounded-2xl flex flex-col overflow-hidden shadow-inner relative">
        <div className="p-4 bg-white border-b border-slate-200 flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center text-blue-600">🤖</div>
          <div>
            <h3 className="font-bold text-slate-800">AutoPartIQ Assistant</h3>
            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Always Online • Powered by Gemini</p>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {messages.length === 0 && (
            <div className="text-center py-10">
              <div className="w-16 h-16 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-4 text-3xl">👋</div>
              <h4 className="font-bold text-slate-800">Hello, Company Owner</h4>
              <p className="text-slate-500 text-sm max-w-xs mx-auto mt-2">Ask me about your inventory levels, profit margins, or which parts are selling best.</p>
              <div className="flex flex-wrap justify-center gap-2 mt-6">
                {['Low stock report', 'Total value', 'Pricing advice'].map(tip => (
                    <button 
                        key={tip} 
                        onClick={() => setInput(tip)}
                        className="text-xs px-3 py-1.5 bg-white border border-slate-200 rounded-full text-slate-600 hover:border-blue-500 hover:text-blue-600 transition-all shadow-sm"
                    >
                        {tip}
                    </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-2xl px-4 py-3 ${
                msg.role === 'user' 
                ? 'bg-blue-600 text-white rounded-tr-none' 
                : 'bg-white text-slate-800 shadow-sm border border-slate-100 rounded-tl-none'
              }`}>
                <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
              </div>
            </div>
          ))}
          {isTyping && (
            <div className="flex justify-start">
              <div className="bg-white px-4 py-3 rounded-2xl shadow-sm border border-slate-100 rounded-tl-none flex gap-1 items-center">
                <div className="w-1.5 h-1.5 bg-slate-300 rounded-full animate-bounce"></div>
                <div className="w-1.5 h-1.5 bg-slate-300 rounded-full animate-bounce" style={{animationDelay: '0.2s'}}></div>
                <div className="w-1.5 h-1.5 bg-slate-300 rounded-full animate-bounce" style={{animationDelay: '0.4s'}}></div>
              </div>
            </div>
          )}
          <div ref={chatEndRef}></div>
        </div>

        <form onSubmit={handleSendMessage} className="p-4 bg-white border-t border-slate-200">
          <div className="relative">
            <input 
              type="text" 
              placeholder="Ask AutoPartIQ..." 
              className="w-full pl-4 pr-12 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none focus:bg-white transition-all"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            <button 
              type="submit"
              className="absolute right-2 top-2 w-8 h-8 bg-blue-600 text-white rounded-lg flex items-center justify-center hover:bg-blue-700 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 10l7-7m0 0l7 7m-7-7v18"></path>
              </svg>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default AIAnalyst;
