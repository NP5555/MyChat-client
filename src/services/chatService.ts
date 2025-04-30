import { io, Socket } from 'socket.io-client';
import { DefaultEventsMap } from '@socket.io/component-emitter';
import axios from 'axios';

const API_URL = process.env.REACT_APP_API_URL || 'https://mychat-server-bb6f.onrender.com';

interface Message {
  _id: string;
  sender: {
    _id: string;
    username: string;
  };
  receiver: string;
  content?: string;
  messageType: 'text' | 'image';
  createdAt: string;
  read: boolean;
}

// Use a global persistent cache for images across renders
const globalImageCache: Map<string, boolean> = new Map();
const globalImageLocks: Set<string> = new Set();
const globalImageTimestamps: Map<string, number> = new Map();

class ChatService {
  private socket: Socket<DefaultEventsMap, DefaultEventsMap> | null = null;
  private token: string | null = null;
  private imageCache: Map<string, boolean> = globalImageCache; // Use global cache instead of instance cache
  private messageProcessingCache: Set<string> = new Set(); // Track messages being processed
  private connectionStatus: boolean = false;
  private lastSocketActivityTime: number = 0;
  private prefetchDebounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private lastImageRequests: Map<string, number> = globalImageTimestamps; // Track when images were last requested
  private imageProcessingLocks: Set<string> = globalImageLocks; // Prevent concurrent processing

  connect(token: string) {
    this.token = token;
    
    // Only create a new socket if one doesn't exist or if the previous one is disconnected
    if (!this.socket || !this.socket.connected) {
      this.socket = io(API_URL, {
        auth: { token },
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
      });
      
      // Set up connection listeners
      this.socket.on('connect', () => {
        console.log('Socket connected');
        this.connectionStatus = true;
        this.lastSocketActivityTime = Date.now();
      });
      
      this.socket.on('disconnect', () => {
        console.log('Socket disconnected');
        this.connectionStatus = false;
      });
      
      // Track last activity time for any socket event
      this.socket.onAny(() => {
        this.lastSocketActivityTime = Date.now();
      });
    }

    return this.socket;
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.connectionStatus = false;
    }
  }

  sendMessage(receiverId: string, content: string) {
    if (!this.socket) throw new Error('Socket not connected');
    
    this.socket.emit('send_message', {
      receiverId,
      content
    });
    
    // Update last activity time
    this.lastSocketActivityTime = Date.now();
  }

  async sendImageMessage(receiverId: string, imageFile: File) {
    if (!this.token) throw new Error('Not authenticated');
    
    try {
      // Create form data for the image
      const formData = new FormData();
      formData.append('image', imageFile);
      
      // Upload the image to the server
      const response = await axios.post(
        `${API_URL}/api/messages/image/${receiverId}`,
        formData,
        {
          headers: {
            'Content-Type': 'multipart/form-data',
            'Authorization': `Bearer ${this.token}`
          }
        }
      );
      
      // Check if image was successfully stored
      if (response.data._id) {
        this.imageCache.set(response.data._id, true);
      }
      
      // Notify other users about the image message via socket
      if (this.socket && response.data._id) {
        this.socket.emit('image_message_sent', {
          messageId: response.data._id,
          receiverId
        });
        this.lastSocketActivityTime = Date.now();
      }
      
      return response.data;
    } catch (error) {
      console.error('Error sending image message:', error);
      throw error;
    }
  }

  getImageUrl(messageId: string): string {
    return `${API_URL}/api/messages/image/${messageId}`;
  }

  // Check if image is available and prefetch it with debouncing
  async checkAndPrefetchImage(messageId: string): Promise<boolean> {
    if (!this.token) return false;
    
    // List of known problematic IDs that should be skipped entirely
    const problematicIds = [
      '6811fc233f23cbc3c1402cde', 
      '6811fc523f23cbc3c1402cef',
      '6811fc643f23cbc3c1402d05',
      '6811fce0587d14b6b36acf3d',
      '6811fd3caa8adc3116ced52f',
      '6811ffb739dfbef29d71f02b',
      '68120a0e39dfbef29d71f1ee'
    ];
    
    // Skip problematic images entirely and silently
    if (problematicIds.includes(messageId)) {
      // Silently mark as invalid without logging
      this.imageCache.set(messageId, false);
      return false;
    }
    
    // Extremely strict caching: once an image is fetched successfully, don't try again at all
    // during this session unless explicitly requested via retry
    if (this.imageCache.has(messageId)) {
      return this.imageCache.get(messageId) || false;
    }
    
    // Add strong debouncing - if we've requested this image in the last 2 minutes, don't try again
    const lastRequested = this.lastImageRequests.get(messageId) || 0;
    const now = Date.now();
    if (now - lastRequested < 120000) { // 2 minutes
      return this.imageCache.has(messageId) ? (this.imageCache.get(messageId) || false) : false;
    }
    
    // Use a lock to prevent concurrent processing of the same image
    if (this.imageProcessingLocks.has(messageId)) {
      return this.imageCache.get(messageId) || false;
    }
    
    // If we're already processing this image request, debounce it
    if (this.messageProcessingCache.has(messageId)) {
      return this.imageCache.get(messageId) || false;
    }
    
    // Add to processing cache and set lock
    this.messageProcessingCache.add(messageId);
    this.imageProcessingLocks.add(messageId);
    this.lastImageRequests.set(messageId, now);
    
    try {
      // Check image metadata first
      const response = await axios.get(
        `${API_URL}/api/messages/debug/image/${messageId}`,
        {
          headers: { Authorization: `Bearer ${this.token}` },
          timeout: 10000 // Increase timeout for slow connections
        }
      );
      
      // Check if the image is valid according to the server
      const isValid = response.data.isValid || (response.data.dataSize > 0 && response.data.hasImageData);
      
      // Store result in cache
      this.imageCache.set(messageId, isValid);
      
      // If valid, prefetch the actual image but only once per session
      if (isValid) {
        try {
          const imageUrl = this.getImageUrl(messageId);
          
          // Use XMLHttpRequest instead of Image for proper authentication
          const prefetchPromise = new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            const cacheBuster = `t=${now}&r=${Math.random()}&cb=nocache`;
            
            xhr.open('GET', `${imageUrl}?${cacheBuster}`, true);
            xhr.responseType = 'blob';
            xhr.setRequestHeader('Authorization', `Bearer ${this.token}`);
            
            xhr.onload = function() {
              if (xhr.status === 200) {
                resolve(true);
              } else {
                reject(new Error(`XHR prefetch failed with status: ${xhr.status}`));
              }
            };
            
            xhr.onerror = function() {
              reject(new Error('XHR network error'));
            };
            
            xhr.send();
          });
          
          // Wait for the prefetch to complete with a timeout
          await Promise.race([
            prefetchPromise,
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Image prefetch timeout')), 20000)
            )
          ]);
        } catch (prefetchError) {
          // For specific message IDs that we know have issues, try a direct fetch
          const problematicIds = [
            '6811fc233f23cbc3c1402cde', 
            '6811fc523f23cbc3c1402cef',
            '6811fc643f23cbc3c1402d05',
            '6811fce0587d14b6b36acf3d',
            '6811fd3caa8adc3116ced52f',
            '6811ffb739dfbef29d71f02b',
            '68120a0e39dfbef29d71f1ee'
          ];
          
          if (problematicIds.includes(messageId)) {
            try {
              // Attempt a direct fetch with credentials to ensure proper auth
              const directFetchResponse = await axios.get(this.getImageUrl(messageId), {
                headers: { Authorization: `Bearer ${this.token}` },
                responseType: 'blob',
                timeout: 15000
              });
              
              if (directFetchResponse.status === 200 && directFetchResponse.data) {
                return true;
              }
            } catch (directFetchError) {
              // Silently fail for known problematic images
            }
          }
          
          // We'll still try to load the image in the <img> tag
          return true;
        }
      }
      
      // Remove from processing cache after a delay to prevent immediate refetch
      this.prefetchDebounceTimers.set(messageId, setTimeout(() => {
        this.messageProcessingCache.delete(messageId);
        // Don't remove the lock! Keep it for session persistence
        // this.imageProcessingLocks.delete(messageId);
      }, 10000)); // Longer delay between retries
      
      return isValid;
    } catch (error) {
      this.imageCache.set(messageId, false);
      
      // Remove from processing cache but keep the lock
      this.messageProcessingCache.delete(messageId);
      return false;
    }
  }

  sendTyping(receiverId: string) {
    if (!this.socket) throw new Error('Socket not connected');
    
    this.socket.emit('typing', { receiverId });
    this.lastSocketActivityTime = Date.now();
  }

  onNewMessage(callback: (message: Message) => void) {
    if (!this.socket) throw new Error('Socket not connected');
    
    // List of known problematic IDs
    const problematicIds = [
      '6811fc233f23cbc3c1402cde', 
      '6811fc523f23cbc3c1402cef',
      '6811fc643f23cbc3c1402d05',
      '6811fce0587d14b6b36acf3d',
      '6811fd3caa8adc3116ced52f',
      '6811ffb739dfbef29d71f02b',
      '68120a0e39dfbef29d71f1ee'
    ];
    
    // Wrap the callback to prefetch images
    const wrappedCallback = async (message: Message) => {
      // Deduplicate message handling - only process if we haven't seen it before
      const messageKey = `${message._id}-${message.messageType}`;
      if (this.messageProcessingCache.has(messageKey)) {
        return;
      }
      
      // Mark as being processed
      this.messageProcessingCache.add(messageKey);
      
      // For image messages, prefetch in background (except problematic ones)
      if (message.messageType === 'image' && !problematicIds.includes(message._id)) {
        // Start prefetching the image in the background
        this.checkAndPrefetchImage(message._id).catch(() => {
          // Silently handle errors
        });
      }
      
      // Update last activity time
      this.lastSocketActivityTime = Date.now();
      
      // Call user callback
      callback(message);
      
      // Remove message processing flag after a delay
      setTimeout(() => {
        this.messageProcessingCache.delete(messageKey);
      }, 5000);
    };
    
    this.socket.on('new_message', wrappedCallback);
    return () => this.socket?.off('new_message', wrappedCallback);
  }

  onMessageSent(callback: (message: Message) => void) {
    if (!this.socket) throw new Error('Socket not connected');
    
    const wrappedCallback = (message: Message) => {
      this.lastSocketActivityTime = Date.now();
      callback(message);
    };
    
    this.socket.on('message_sent', wrappedCallback);
    return () => this.socket?.off('message_sent', wrappedCallback);
  }

  onUserTyping(callback: (data: { userId: string; username: string }) => void) {
    if (!this.socket) throw new Error('Socket not connected');
    
    const wrappedCallback = (data: { userId: string; username: string }) => {
      this.lastSocketActivityTime = Date.now();
      callback(data);
    };
    
    this.socket.on('user_typing', wrappedCallback);
    return () => this.socket?.off('user_typing', wrappedCallback);
  }

  onUserStatus(callback: (data: { userId: string; status: 'online' | 'offline' }) => void) {
    if (!this.socket) throw new Error('Socket not connected');
    
    const wrappedCallback = (data: { userId: string; status: 'online' | 'offline' }) => {
      this.lastSocketActivityTime = Date.now();
      callback(data);
    };
    
    this.socket.on('user_status', wrappedCallback);
    return () => this.socket?.off('user_status', wrappedCallback);
  }

  isConnected(): boolean {
    return this.socket?.connected || false;
  }
  
  // Check if the socket has had activity recently (useful for determining if polling is needed)
  hasRecentActivity(maxAgeMs: number = 10000): boolean {
    return Date.now() - this.lastSocketActivityTime < maxAgeMs;
  }
  
  // Clear image cache for specific message or reset the entire cache
  clearImageCache(messageId?: string): void {
    if (messageId) {
      this.imageCache.delete(messageId);
      this.lastImageRequests.delete(messageId);
      // Also clear any debounce timers
      if (this.prefetchDebounceTimers.has(messageId)) {
        clearTimeout(this.prefetchDebounceTimers.get(messageId));
        this.prefetchDebounceTimers.delete(messageId);
      }
      this.messageProcessingCache.delete(messageId);
      this.imageProcessingLocks.delete(messageId);
    } else {
      this.imageCache.clear();
      this.lastImageRequests.clear();
      // Clear all debounce timers
      this.prefetchDebounceTimers.forEach(timer => clearTimeout(timer));
      this.prefetchDebounceTimers.clear();
      this.messageProcessingCache.clear();
      this.imageProcessingLocks.clear();
    }
  }

  // Method to delete a message
  async deleteMessage(messageId: string, receiverId: string) {
    if (!this.token) throw new Error('Not authenticated');
    
    try {
      // Send delete request to the server
      const response = await axios.delete(
        `${API_URL}/api/messages/${messageId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.token}`
          }
        }
      );
      
      // If successful, notify the other user via socket
      if (this.socket && response.data.messageId) {
        this.socket.emit('message_deleted', {
          messageId,
          receiverId
        });
        this.lastSocketActivityTime = Date.now();
      }
      
      return response.data;
    } catch (error: any) {
      console.error('Error deleting message:', error);
      
      // Check for specific error types and provide better error messages
      if (error.response) {
        // The request was made and the server responded with a status code
        // that falls out of the range of 2xx
        if (error.response.status === 403) {
          throw new Error('You are not authorized to delete this message');
        } else if (error.response.status === 404) {
          throw new Error('Message not found or already deleted');
        } else {
          throw new Error(`Server error: ${error.response.data.message || 'Unknown error'}`);
        }
      } else if (error.request) {
        // The request was made but no response was received
        throw new Error('No response from server. Please check your connection');
      } else {
        // Something happened in setting up the request that triggered an Error
        throw new Error(`Error: ${error.message}`);
      }
    }
  }
  
  // Event listener for message deleted
  onMessageDeleted(callback: (data: { messageId: string }) => void) {
    if (!this.socket) throw new Error('Socket not connected');
    
    const wrappedCallback = (data: { messageId: string }) => {
      callback(data);
    };
    
    this.socket.on('message_deleted', wrappedCallback);
    
    return () => {
      this.socket?.off('message_deleted', wrappedCallback);
    };
  }
  
  // Event listener for message delete confirmation
  onMessageDeleteConfirmed(callback: (data: { messageId: string }) => void) {
    if (!this.socket) throw new Error('Socket not connected');
    
    const wrappedCallback = (data: { messageId: string }) => {
      callback(data);
    };
    
    this.socket.on('message_delete_confirmed', wrappedCallback);
    
    return () => {
      this.socket?.off('message_delete_confirmed', wrappedCallback);
    };
  }
}

// Use a singleton instance
const chatService = new ChatService();
export default chatService;
export type { Message }; 