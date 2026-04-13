"use client";

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Users, UserPlus, MessageCircle, X, Search, Check, Trash2, ExternalLink, Bell } from 'lucide-react';

interface Friend {
  _id: string;
  name: string;
  handle: string;
  userNumber: string;
  discordId?: string;
  discordHandle?: string;
}

interface Request {
  _id: string;
  from?: Friend;
  to?: Friend;
  status: string;
}

export default function SocialDock() {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'friends' | 'requests' | 'add'>('friends');
  const [friends, setFriends] = useState<Friend[]>([]);
  const [incomingRequests, setIncomingRequests] = useState<Request[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResult, setSearchResult] = useState<Friend | null>(null);
  const [searchError, setSearchError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [notificationCount, setNotificationCount] = useState(0);

  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) {
      fetchSocialData();
      const interval = setInterval(fetchSocialData, 30000); // Poll every 30s
      return () => clearInterval(interval);
    }
  }, []);

  const fetchSocialData = async () => {
    const token = localStorage.getItem('token');
    if (!token) return;

    try {
      const [friendsRes, requestsRes] = await Promise.all([
        fetch('/api/friends/list', { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch('/api/friends/requests', { headers: { 'Authorization': `Bearer ${token}` } })
      ]);

      if (friendsRes.ok) {
        const friendsData = await friendsRes.json();
        setFriends(friendsData);
      }

      if (requestsRes.ok) {
        const requestsData = await requestsRes.json();
        setIncomingRequests(requestsData.incoming);
        setNotificationCount(requestsData.incoming.length);
      }
    } catch (err) {
      console.error("Failed to fetch social data", err);
    }
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setSearchError('');
    setSearchResult(null);

    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`/api/friends/search?query=${encodeURIComponent(searchQuery)}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok) {
        setSearchResult(data);
      } else {
        setSearchError(data.error || "User not found");
      }
    } catch (err) {
      setSearchError("Search failed");
    } finally {
      setIsLoading(false);
    }
  };

  const sendRequest = async (toUserId: string) => {
    const token = localStorage.getItem('token');
    try {
      const res = await fetch('/api/friends/request', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ toUserId })
      });
      if (res.ok) {
        alert("Friend request sent!");
        setSearchResult(null);
        setSearchQuery('');
      } else {
        const data = await res.json();
        alert(data.error || "Failed to send request");
      }
    } catch (err) {
      alert("Error sending request");
    }
  };

  const respondToRequest = async (requestId: string, action: 'accept' | 'reject') => {
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`/api/friends/request/${requestId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ action })
      });
      if (res.ok) {
        fetchSocialData();
      }
    } catch (err) {
      console.error("Error responding to request", err);
    }
  };

  const removeFriend = async (friendId: string) => {
    if (!confirm("Are you sure you want to remove this friend?")) return;
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`/api/friends/${friendId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        fetchSocialData();
      }
    } catch (err) {
      console.error("Error removing friend", err);
    }
  };

  const openDiscordDM = (discordId: string) => {
    window.open(`https://discord.com/channels/@me/${discordId}`, '_blank');
  };

  return (
    <>
      {/* Persistent Nav Trigger */}
      <button
        onClick={() => setIsOpen(true)}
        className="group relative flex items-center gap-2 px-4 py-2 bg-black border-2 border-white text-white font-bold hover:bg-white hover:text-black transition-all shadow-[4px_4px_0px_0px_rgba(255,255,255,1)] active:shadow-none active:translate-x-1 active:translate-y-1"
      >
        <Users size={20} className="group-hover:rotate-12 transition-transform" />
        <span className="hidden md:inline font-permanent">SOCIAL</span>
        {notificationCount > 0 && (
          <span className="absolute -top-2 -right-2 flex h-5 w-5 items-center justify-center rounded-full bg-red-600 border-2 border-white text-[10px] font-black animate-pulse">
            {notificationCount}
          </span>
        )}
      </button>

      {/* Overlay Panel */}
      <AnimatePresence>
        {isOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsOpen(false)}
              className="fixed inset-0 bg-black/60 z-[60] backdrop-blur-sm"
            />
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed top-0 right-0 h-full w-full max-w-md bg-zinc-900 border-l-8 border-black z-[70] shadow-[-10px_0px_30px_rgba(0,0,0,0.5)] flex flex-col overflow-hidden"
            >
              {/* Header */}
              <div className="p-6 border-b-4 border-black bg-teal-600 flex justify-between items-center">
                <h2 className="text-3xl font-black text-white italic tracking-tighter flex items-center gap-3">
                  <MessageCircle size={32} fill="white" />
                  SOCIAL HUB
                </h2>
                <button 
                  onClick={() => setIsOpen(false)}
                  className="p-2 bg-black border-2 border-white text-white hover:bg-red-600 transition-colors"
                >
                  <X size={20} />
                </button>
              </div>

              {/* Tabs */}
              <div className="flex border-b-4 border-black bg-zinc-800">
                {(['friends', 'requests', 'add'] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`flex-1 py-4 font-black text-sm uppercase tracking-widest transition-all ${
                      activeTab === tab 
                        ? 'bg-yellow-400 text-black' 
                        : 'text-zinc-400 hover:text-white hover:bg-zinc-700'
                    }`}
                  >
                    {tab}
                    {tab === 'requests' && notificationCount > 0 && ` (${notificationCount})`}
                  </button>
                ))}
              </div>

              {/* Content */}
              <div className="flex-grow overflow-y-auto p-6 space-y-4 custom-scrollbar">
                
                {/* FRIENDS TAB */}
                {activeTab === 'friends' && (
                  <div className="space-y-4">
                    {friends.length === 0 ? (
                      <div className="text-center py-12 text-zinc-500 border-4 border-dashed border-zinc-700 font-bold uppercase">
                        No friends yet.<br/>Go find some!
                      </div>
                    ) : (
                      friends.map((friend) => (
                        <div key={friend._id} className="p-4 bg-zinc-800 border-4 border-black shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] hover:translate-x-1 hover:translate-y-1 hover:shadow-none transition-all">
                          <div className="flex justify-between items-start mb-3">
                            <div>
                              <h3 className="font-black text-xl text-white">@{friend.handle.toUpperCase()}</h3>
                              <p className="text-xs text-zinc-500 font-bold">#{friend.userNumber}</p>
                            </div>
                            <button 
                              onClick={() => removeFriend(friend._id)}
                              className="text-zinc-600 hover:text-red-500 transition-colors"
                            >
                              <Trash2 size={18} />
                            </button>
                          </div>
                          
                          <div className="flex gap-2">
                            {friend.discordId ? (
                              <button
                                onClick={() => openDiscordDM(friend.discordId!)}
                                className="flex-grow flex items-center justify-center gap-2 py-2 bg-[#5865F2] border-2 border-black text-white font-black text-xs uppercase hover:bg-[#4752c4] transition-colors"
                              >
                                <ExternalLink size={14} />
                                CHAT ON DISCORD
                              </button>
                            ) : (
                                <div className="flex-grow py-2 bg-zinc-700 border-2 border-black text-zinc-400 font-black text-[10px] text-center uppercase">
                                  Discord not linked
                                </div>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}

                {/* REQUESTS TAB */}
                {activeTab === 'requests' && (
                  <div className="space-y-4">
                    {incomingRequests.length === 0 ? (
                      <div className="text-center py-12 text-zinc-500 border-4 border-dashed border-zinc-700 font-bold uppercase">
                        No pending requests.
                      </div>
                    ) : (
                      incomingRequests.map((req) => (
                        <div key={req._id} className="p-4 bg-zinc-800 border-4 border-black shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]">
                          <div className="mb-4">
                            <p className="text-xs text-teal-400 font-black uppercase mb-1">New Request From:</p>
                            <h3 className="font-black text-xl text-white">@{req.from?.handle?.toUpperCase()}</h3>
                            <p className="text-xs text-zinc-500 font-bold">#{req.from?.userNumber}</p>
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={() => respondToRequest(req._id, 'accept')}
                              className="flex-1 flex items-center justify-center gap-2 py-2 bg-green-500 border-2 border-black text-black font-black text-xs uppercase hover:bg-green-400 transition-colors"
                            >
                              <Check size={14} /> ACCEPT
                            </button>
                            <button
                              onClick={() => respondToRequest(req._id, 'reject')}
                              className="flex-1 flex items-center justify-center gap-2 py-2 bg-red-500 border-2 border-black text-black font-black text-xs uppercase hover:bg-red-400 transition-colors"
                            >
                              <X size={14} /> DECLINE
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}

                {/* ADD TAB */}
                {activeTab === 'add' && (
                  <div className="space-y-6">
                    <form onSubmit={handleSearch} className="space-y-2">
                      <label className="text-xs font-black text-zinc-400 uppercase tracking-widest">
                        Search by Unique ID
                      </label>
                      <div className="relative">
                        <input
                          type="text"
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          placeholder="handle#1234"
                          className="w-full bg-black border-4 border-black p-3 text-white font-black placeholder-zinc-700 focus:border-teal-600 outline-none transition-colors"
                        />
                        <button 
                          type="submit"
                          disabled={isLoading}
                          className="absolute right-2 top-2 p-2 bg-yellow-400 text-black border-2 border-black hover:bg-white transition-colors"
                        >
                          {isLoading ? "..." : <Search size={20} />}
                        </button>
                      </div>
                      {searchError && <p className="text-red-500 text-xs font-black uppercase">{searchError}</p>}
                    </form>

                    {searchResult && (
                      <div className="p-4 bg-zinc-800 border-4 border-black shadow-[6px_6px_0px_0px_rgba(255,255,255,0.1)] animate-in fade-in zoom-in duration-300">
                        <div className="mb-4">
                          <h3 className="font-black text-2xl text-white">@{searchResult.handle.toUpperCase()}</h3>
                          <p className="text-xs text-zinc-500 font-bold">#{searchResult.userNumber}</p>
                        </div>
                        <button
                          onClick={() => sendRequest(searchResult._id)}
                          className="w-full flex items-center justify-center gap-2 py-3 bg-teal-500 border-2 border-black text-black font-black uppercase hover:bg-teal-400 transition-colors shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] active:shadow-none active:translate-x-1 active:translate-y-1"
                        >
                          <UserPlus size={18} /> SEND FRIEND REQUEST
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="p-6 bg-black border-t-4 border-zinc-800">
                <p className="text-[10px] text-zinc-600 font-black uppercase tracking-[0.2em] leading-relaxed">
                  Connect by handle. Chat on Discord.<br/>
                  The Personal Web App Social Layer v1.0
                </p>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
