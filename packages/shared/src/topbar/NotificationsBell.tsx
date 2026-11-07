"use client";

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { Bell, Check, MessageSquare, UserPlus, Map, Info, X, CheckCheck } from 'lucide-react';
import type { Letters } from '../letters/letters';
import { useSession } from '../session/react';
import { notificationTarget } from './notificationLink';

interface Notification {
  _id: string;
  type: 'friend_request' | 'campaign_invite' | 'message' | 'system';
  title: string;
  body?: string;
  link?: string;
  meta?: { requestId?: string; inviteId?: string; campaignId?: string; fromUserId?: string };
  count: number;
  read: boolean;
  createdAt: string;
}

const TYPE_ICON: Record<Notification['type'], React.ReactNode> = {
  friend_request: <UserPlus size={16} className="text-black" />,
  campaign_invite: <Map size={16} className="text-black" />,
  message: <MessageSquare size={16} className="text-black" />,
  system: <Info size={16} className="text-black" />,
};

const TYPE_BG: Record<Notification['type'], string> = {
  friend_request: 'bg-yellow-400',
  campaign_invite: 'bg-teal-500',
  message: 'bg-orange-500',
  system: 'bg-zinc-300',
};

/** The top bar's bell (#211): notifications, with friend requests and campaign invites answered in place. */
export default function NotificationsBell({ letters }: { letters: Letters }) {
  const { api, session } = letters;
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const signedIn = useSession(session).status === 'signedIn';

  const fetchNotifications = useCallback(async () => {
    try {
      const data = await api.get<{ notifications?: Notification[]; unreadCount?: number }>('/api/notifications?limit=30');
      setNotifications(data?.notifications || []);
      setUnreadCount(data?.unreadCount || 0);
    } catch {
      /* polling — next tick will retry */
    }
  }, [api]);

  useEffect(() => {
    if (!signedIn) return;
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 30000);
    return () => clearInterval(interval);
  }, [signedIn, fetchNotifications]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setIsOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [isOpen]);

  const markRead = async (id: string) => {
    await api.put(`/api/notifications/${id}/read`).catch(() => {});
    fetchNotifications();
  };

  const markAllRead = async () => {
    await api.put('/api/notifications/read-all').catch(() => {});
    fetchNotifications();
  };

  const respondFriendRequest = async (n: Notification, action: 'accept' | 'reject') => {
    if (!n.meta?.requestId) return;
    setBusy(n._id);
    try {
      await api.put(`/api/friends/request/${n.meta.requestId}`, { action }).catch(() => {});
      await markRead(n._id);
    } finally {
      setBusy(null);
    }
  };

  const respondInvite = async (n: Notification, action: 'accept' | 'decline') => {
    if (!n.meta?.inviteId) return;
    setBusy(n._id);
    try {
      await api.put(`/api/campaign-invites/${n.meta.inviteId}/respond`, { action }).catch(() => {});
      await markRead(n._id);
      if (action === 'accept' && n.meta?.campaignId) router.push(`/game-night/campaigns/${n.meta.campaignId}`);
    } finally {
      setBusy(null);
    }
  };

  const handleClick = (n: Notification) => {
    if (!n.read) markRead(n._id);
    // A relative `/game-night/...` path, or an absolute Hearthside URL once
    // the backend has HEARTHSIDE_URL (#214): the router for this site, a full
    // page load for the other.
    const target = notificationTarget(n.link, window.location.href);
    if (target) {
      setIsOpen(false);
      if (target.kind === 'route') router.push(target.href);
      else window.location.assign(target.href);
    }
  };

  const fmtWhen = (iso: string) => {
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'NOW';
    if (mins < 60) return `${mins}M AGO`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}H AGO`;
    return `${Math.floor(hrs / 24)}D AGO`;
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setIsOpen(o => !o)}
        aria-label="Notifications"
        className="group relative flex items-center px-3 py-2 bg-black border-2 border-white text-white hover:bg-white hover:text-black transition-all shadow-[4px_4px_0px_0px_rgba(255,255,255,1)] active:shadow-none active:translate-x-1 active:translate-y-1"
      >
        <Bell size={20} className="group-hover:rotate-12 transition-transform" />
        {unreadCount > 0 && (
          <span className="absolute -top-2 -right-2 flex h-5 min-w-5 px-1 items-center justify-center rounded-full bg-red-600 border-2 border-white text-[10px] font-black animate-pulse">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-x-3 top-[84px] sm:absolute sm:inset-x-auto sm:top-auto sm:right-0 sm:mt-3 sm:w-96 max-h-[70vh] bg-zinc-900 border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] z-[80] flex flex-col"
          >
            <div className="p-4 border-b-4 border-black bg-teal-600 flex justify-between items-center shrink-0">
              <h3 className="font-black text-white text-lg italic tracking-tight flex items-center gap-2">
                <Bell size={18} fill="white" /> NOTIFICATIONS
              </h3>
              <div className="flex items-center gap-2">
                {unreadCount > 0 && (
                  <button
                    onClick={markAllRead}
                    title="Mark all read"
                    className="p-1.5 bg-black border-2 border-white text-white hover:bg-yellow-400 hover:text-black transition-colors"
                  >
                    <CheckCheck size={14} />
                  </button>
                )}
                <button
                  onClick={() => setIsOpen(false)}
                  className="p-1.5 bg-black border-2 border-white text-white hover:bg-red-600 transition-colors"
                >
                  <X size={14} />
                </button>
              </div>
            </div>

            <div className="overflow-y-auto custom-scrollbar">
              {notifications.length === 0 ? (
                <div className="p-8 text-center text-zinc-500 font-bold uppercase text-xs">
                  All quiet. No notifications.
                </div>
              ) : (
                notifications.map(n => (
                  <div
                    key={n._id}
                    onClick={() => handleClick(n)}
                    className={`p-4 border-b-2 border-black flex gap-3 transition-colors ${n.read ? 'bg-zinc-900 opacity-60' : 'bg-zinc-800'} ${n.link ? 'cursor-pointer hover:bg-zinc-700' : ''}`}
                  >
                    <div className={`p-1.5 border-2 border-black h-fit shrink-0 ${TYPE_BG[n.type]}`}>
                      {TYPE_ICON[n.type]}
                    </div>
                    <div className="min-w-0 flex-grow">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="font-black text-sm text-white leading-snug">
                          {n.title}{n.count > 1 ? ` (${n.count})` : ''}
                        </p>
                        <span className="text-[9px] text-zinc-500 font-bold shrink-0">{fmtWhen(n.createdAt)}</span>
                      </div>
                      {n.body && <p className="text-xs text-zinc-400 font-bold mt-0.5 break-words">{n.body}</p>}

                      {!n.read && n.type === 'friend_request' && n.meta?.requestId && (
                        <div className="flex gap-2 mt-2" onClick={e => e.stopPropagation()}>
                          <button
                            disabled={busy === n._id}
                            onClick={() => respondFriendRequest(n, 'accept')}
                            className="flex-1 flex items-center justify-center gap-1 py-1.5 bg-green-500 border-2 border-black text-black font-black text-[10px] uppercase hover:bg-green-400 transition-colors disabled:opacity-50"
                          >
                            <Check size={12} /> ACCEPT
                          </button>
                          <button
                            disabled={busy === n._id}
                            onClick={() => respondFriendRequest(n, 'reject')}
                            className="flex-1 flex items-center justify-center gap-1 py-1.5 bg-red-500 border-2 border-black text-black font-black text-[10px] uppercase hover:bg-red-400 transition-colors disabled:opacity-50"
                          >
                            <X size={12} /> DECLINE
                          </button>
                        </div>
                      )}

                      {!n.read && n.type === 'campaign_invite' && n.meta?.inviteId && (
                        <div className="flex gap-2 mt-2" onClick={e => e.stopPropagation()}>
                          <button
                            disabled={busy === n._id}
                            onClick={() => respondInvite(n, 'accept')}
                            className="flex-1 flex items-center justify-center gap-1 py-1.5 bg-green-500 border-2 border-black text-black font-black text-[10px] uppercase hover:bg-green-400 transition-colors disabled:opacity-50"
                          >
                            <Check size={12} /> JOIN
                          </button>
                          <button
                            disabled={busy === n._id}
                            onClick={() => respondInvite(n, 'decline')}
                            className="flex-1 flex items-center justify-center gap-1 py-1.5 bg-red-500 border-2 border-black text-black font-black text-[10px] uppercase hover:bg-red-400 transition-colors disabled:opacity-50"
                          >
                            <X size={12} /> DECLINE
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
