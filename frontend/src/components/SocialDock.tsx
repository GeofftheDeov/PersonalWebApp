"use client";

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Link from 'next/link';
import { Users, UserPlus, MessageCircle, X, Search, Check, Trash2, ExternalLink, ArrowLeft, Map, MessageSquare, User as UserIcon } from 'lucide-react';
import ChatThread, { ChatChannel } from './ChatThread';
import { useThreads, threadKeyFor, ThreadFilter, ThreadSummary } from '../lib/useThreads';

interface Friend {
  _id: string;
  name: string;
  handle: string | null;
  userNumber: string;
  recordType?: string;
  discordId?: string;
  discordHandle?: string;
}

/** Display name: handle if set, otherwise the record's name (never an email). */
const friendLabel = (f: { handle?: string | null; name?: string }) => f.handle || f.name || 'UNKNOWN';

interface Request {
  _id: string;
  from?: Friend;
  to?: Friend;
  status: string;
}

interface ActiveChat {
  channel: ChatChannel;
  title: string;
}

/** Last activity, compact: NOW, 5M, 3H, 2D, then a date. */
const fmtActivity = (iso: string | null) => {
  if (!iso) return '';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'NOW';
  if (mins < 60) return `${mins}M`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}H`;
  if (mins < 7 * 24 * 60) return `${Math.floor(mins / (24 * 60))}D`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase();
};

const chatFor = (t: ThreadSummary): ActiveChat => ({
  channel: { kind: t.kind, id: t.targetId },
  title: t.kind === 'dm' ? `@${t.title}` : t.title,
});

export default function SocialDock() {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'chats' | 'friends' | 'requests' | 'add'>('chats');
  const [friends, setFriends] = useState<Friend[]>([]);
  const [incomingRequests, setIncomingRequests] = useState<Request[]>([]);
  const [activeChat, setActiveChat] = useState<ActiveChat | null>(null);
  const [chatFilter, setChatFilter] = useState<ThreadFilter>('all');
  const { threads, totalUnread, markRead, refresh: refreshThreads } = useThreads({ filter: chatFilter });
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResult, setSearchResult] = useState<Friend | null>(null);
  const [searchError, setSearchError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [notificationCount, setNotificationCount] = useState(0);
  const [processingRequestId, setProcessingRequestId] = useState<string | null>(null);
  const [feedbackMessage, setFeedbackMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);

  // No polling (#102). Chats follow the live channel through useThreads.
  // Friends and requests load once for the badge, then again whenever the
  // dock opens, along with the thread list as a cheap catch-up.
  useEffect(() => {
    if (localStorage.getItem('token')) fetchSocialData();
  }, []);

  useEffect(() => {
    if (!isOpen || !localStorage.getItem('token')) return;
    fetchSocialData();
    refreshThreads();
  }, [isOpen, refreshThreads]);

  const fetchSocialData = async () => {
    const token = localStorage.getItem('token');
    if (!token) return;

    try {
      const [friendsRes, requestsRes] = await Promise.all([
        fetch('/api/friends/list', { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch('/api/friends/requests', { headers: { 'Authorization': `Bearer ${token}` } }),
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

  const openChat = (chat: ActiveChat) => {
    setActiveChat(chat);
    setActiveTab('chats');
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
    setProcessingRequestId(requestId);
    setFeedbackMessage(null);

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
        const actionText = action === 'accept' ? 'accepted' : 'declined';
        setFeedbackMessage({
          type: 'success',
          text: `Friend request ${actionText}!`
        });
        await fetchSocialData();
        setTimeout(() => setFeedbackMessage(null), 3000);
      } else {
        const data = await res.json();
        setFeedbackMessage({
          type: 'error',
          text: data.error || `Failed to ${action} request`
        });
      }
    } catch (err) {
      console.error("Error responding to request", err);
      setFeedbackMessage({
        type: 'error',
        text: 'Error processing request. Please try again.'
      });
    } finally {
      setProcessingRequestId(null);
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
        {notificationCount + totalUnread > 0 && (
          <span className="absolute -top-2 -right-2 flex h-5 min-w-5 px-1 items-center justify-center rounded-full bg-red-600 border-2 border-white text-[10px] font-black animate-pulse">
            {notificationCount + totalUnread > 99 ? '99+' : notificationCount + totalUnread}
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
                {(['chats', 'friends', 'requests', 'add'] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => { setActiveTab(tab); if (tab !== 'chats') setActiveChat(null); }}
                    className={`flex-1 py-4 font-black text-xs uppercase tracking-widest transition-all ${
                      activeTab === tab
                        ? 'bg-yellow-400 text-black'
                        : 'text-zinc-400 hover:text-white hover:bg-zinc-700'
                    }`}
                  >
                    {tab}
                    {tab === 'chats' && totalUnread > 0 && ` (${totalUnread})`}
                    {tab === 'requests' && notificationCount > 0 && ` (${notificationCount})`}
                  </button>
                ))}
              </div>

              {/* Content */}
              <div className={`flex-grow min-h-0 ${activeTab === 'chats' && activeChat ? 'flex flex-col p-4' : 'overflow-y-auto p-6 space-y-4 custom-scrollbar'}`}>

                {/* CHATS TAB */}
                {activeTab === 'chats' && (
                  activeChat ? (
                    <>
                      <div className="flex items-center gap-3 mb-3 shrink-0">
                        <button
                          onClick={() => { setActiveChat(null); refreshThreads(); }}
                          className="p-2 bg-black border-2 border-white text-white hover:bg-yellow-400 hover:text-black hover:border-black transition-colors"
                          aria-label="Back to chat list"
                        >
                          <ArrowLeft size={16} />
                        </button>
                        <div className="min-w-0">
                          <h3 className="font-black text-lg text-white truncate">{activeChat.title}</h3>
                          <p className="text-[10px] text-zinc-500 font-bold uppercase">
                            {activeChat.channel.kind === 'campaign' ? 'Campaign · Table Talk' : 'Direct Message'}
                          </p>
                        </div>
                      </div>
                      <div className="flex-grow min-h-0 flex flex-col">
                        <ChatThread
                          channel={activeChat.channel}
                          placeholder={activeChat.channel.kind === 'campaign' ? 'MESSAGE THE PARTY…' : `MESSAGE ${activeChat.title.toUpperCase()}…`}
                          onLatestMessage={(messageId) => {
                            const key = threadKeyFor(activeChat.channel.kind, activeChat.channel.id);
                            if (key) markRead(key, messageId);
                          }}
                        />
                      </div>
                    </>
                  ) : (
                    <div className="space-y-4">
                      <div className="flex gap-2">
                        {(['all', 'campaigns', 'friends'] as const).map((f) => (
                          <button
                            key={f}
                            onClick={() => setChatFilter(f)}
                            className={`px-3 py-1 border-2 border-black font-black text-[10px] uppercase tracking-widest transition-colors ${
                              chatFilter === f ? 'bg-teal-500 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-white'
                            }`}
                          >
                            {f}
                          </button>
                        ))}
                      </div>
                      {threads.length === 0 ? (
                        <div className="text-center py-6 text-zinc-500 border-4 border-dashed border-zinc-700 font-bold uppercase text-xs">
                          {chatFilter === 'campaigns' ? 'No active campaigns.' : 'No conversations yet.'}
                          {chatFilter !== 'campaigns' && <><br />Message a friend from the Friends tab.</>}
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {threads.map((t) => (
                            <button
                              key={t.threadKey}
                              onClick={() => openChat(chatFor(t))}
                              className="w-full flex items-center gap-3 p-3 bg-zinc-800 border-4 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:translate-x-1 hover:translate-y-1 hover:shadow-none transition-all text-left"
                            >
                              <div className={`p-1.5 border-2 border-black shrink-0 ${t.kind === 'campaign' ? 'bg-teal-500' : 'bg-yellow-400'}`}>
                                {t.kind === 'campaign'
                                  ? <Map size={14} className="text-white" />
                                  : <Users size={14} className="text-black" />}
                              </div>
                              <div className="min-w-0 flex-grow">
                                <p className={`font-black text-sm truncate uppercase ${t.unreadCount > 0 ? 'text-white' : 'text-zinc-300'}`}>
                                  {t.kind === 'dm' ? `@${t.title}` : t.title}
                                </p>
                                <p className="text-[10px] text-zinc-500 font-bold uppercase">{t.subtitle}</p>
                              </div>
                              <div className="flex flex-col items-end gap-1 shrink-0">
                                <span className="text-[10px] text-zinc-500 font-bold">{fmtActivity(t.lastActivityAt)}</span>
                                {t.unreadCount > 0 ? (
                                  <span
                                    className="min-w-5 h-5 px-1 flex items-center justify-center rounded-full bg-red-600 border-2 border-black text-[10px] font-black text-white"
                                    aria-label={`${t.unreadCount} unread`}
                                  >
                                    {t.unreadCount > 99 ? '99+' : t.unreadCount}
                                  </span>
                                ) : (
                                  <MessageSquare size={16} className="text-zinc-600" />
                                )}
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                )}

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
                              <h3 className="font-black text-xl text-white">@{friendLabel(friend).toUpperCase()}</h3>
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
                            <button
                              onClick={() => openChat({ channel: { kind: 'dm', id: friend._id }, title: `@${friendLabel(friend)}` })}
                              className="flex-grow flex items-center justify-center gap-2 py-2 bg-teal-500 border-2 border-black text-black font-black text-xs uppercase hover:bg-teal-400 transition-colors"
                            >
                              <MessageSquare size={14} />
                              MESSAGE
                            </button>
                            <Link
                              href={`/players/${friend._id}`}
                              onClick={() => setIsOpen(false)}
                              className="flex items-center justify-center gap-2 px-3 py-2 bg-yellow-400 border-2 border-black text-black font-black text-xs uppercase hover:bg-white transition-colors"
                            >
                              <UserIcon size={14} />
                              PROFILE
                            </Link>
                            {friend.discordId && (
                              <button
                                onClick={() => openDiscordDM(friend.discordId!)}
                                className="flex-grow flex items-center justify-center gap-2 py-2 bg-[#5865F2] border-2 border-black text-white font-black text-xs uppercase hover:bg-[#4752c4] transition-colors"
                              >
                                <ExternalLink size={14} />
                                DISCORD
                              </button>
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
                    {feedbackMessage && (
                      <div
                        className={`p-3 border-2 border-black font-black text-xs uppercase ${
                          feedbackMessage.type === 'success'
                            ? 'bg-green-500 text-black'
                            : 'bg-red-500 text-black'
                        }`}
                      >
                        {feedbackMessage.text}
                      </div>
                    )}
                    {incomingRequests.length === 0 ? (
                      <div className="text-center py-12 text-zinc-500 border-4 border-dashed border-zinc-700 font-bold uppercase">
                        No pending requests.
                      </div>
                    ) : (
                      incomingRequests.map((req) => (
                        <div key={req._id} className="p-4 bg-zinc-800 border-4 border-black shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]">
                          <div className="mb-4">
                            <p className="text-xs text-teal-400 font-black uppercase mb-1">New Request From:</p>
                            <h3 className="font-black text-xl text-white">@{req.from ? friendLabel(req.from).toUpperCase() : 'UNKNOWN'}</h3>
                            <p className="text-xs text-zinc-500 font-bold">#{req.from?.userNumber}</p>
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={() => respondToRequest(req._id, 'accept')}
                              disabled={processingRequestId === req._id}
                              className="flex-1 flex items-center justify-center gap-2 py-2 bg-green-500 border-2 border-black text-black font-black text-xs uppercase hover:bg-green-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <Check size={14} /> {processingRequestId === req._id ? 'ACCEPTING...' : 'ACCEPT'}
                            </button>
                            <button
                              onClick={() => respondToRequest(req._id, 'reject')}
                              disabled={processingRequestId === req._id}
                              className="flex-1 flex items-center justify-center gap-2 py-2 bg-red-500 border-2 border-black text-black font-black text-xs uppercase hover:bg-red-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <X size={14} /> {processingRequestId === req._id ? 'DECLINING...' : 'DECLINE'}
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
                          <h3 className="font-black text-2xl text-white">@{friendLabel(searchResult).toUpperCase()}</h3>
                          <p className="text-xs text-zinc-500 font-bold">#{searchResult.userNumber}{searchResult.recordType ? ` · ${searchResult.recordType.toUpperCase()}` : ''}</p>
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
                  Connect by handle. Chat right here.<br/>
                  The Personal Web App Social Layer v2.0
                </p>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
