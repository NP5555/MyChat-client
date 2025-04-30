import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Box,
  Paper,
  TextField,
  IconButton,
  Typography,
  List,
  ListItemButton,
  ListItemText,
  Divider,
  Badge,
  AppBar,
  Toolbar,
  Button,
  InputAdornment,
  useMediaQuery,
  useTheme,
  Drawer,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  CircularProgress,
  Menu,
  MenuItem,
  Snackbar,
  Alert
} from '@mui/material';
import { 
  Send as SendIcon, 
  ExitToApp as LogoutIcon,
  Image as ImageIcon,
  Menu as MenuIcon,
  ArrowBack as ArrowBackIcon,
  Close as CloseIcon,
  Delete as DeleteIcon
} from '@mui/icons-material';
import { useAuth } from '../contexts/AuthContext';
import chatService, { Message } from '../services/chatService';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';

// Define API_URL directly since the config module is having issues
const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5001';

// Create global caches to persist across component unmounts/remounts
const globalImageSrcCache = new Map<string, string>();
const globalImageLoadedState = new Set<string>();

interface User {
  _id: string;
  username: string;
  online?: boolean;
}

const Chat: React.FC = () => {
  const { user, token, logout } = useAuth();
  const navigate = useNavigate();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const [drawerOpen, setDrawerOpen] = useState(false);
  
  const [users, setUsers] = useState<User[]>([]);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [typing, setTyping] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const allMessagesRef = useRef<{[key: string]: Message[]}>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [previewDialogOpen, setPreviewDialogOpen] = useState(false);
  const [imageToUpload, setImageToUpload] = useState<File | null>(null);
  const [lastRefreshTime, setLastRefreshTime] = useState(Date.now());
  const refreshIntervalRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const isInitialLoadRef = useRef(true);
  const mountedRef = useRef(true);
  const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [longPressTimer, setLongPressTimer] = useState<NodeJS.Timeout | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    mouseX: number;
    mouseY: number;
    messageId: string;
  } | null>(null);
  const [alertMessage, setAlertMessage] = useState<{type: 'success' | 'error', message: string} | null>(null);

  // Fetch users function
  const fetchUsers = useCallback(async () => {
    if (!token) return;
    
    try {
      const response = await axios.get(`${API_URL}/api/users`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      console.log('Users API response:', response.data);
      console.log('Current user ID:', user?.id);
      setUsers(response.data.users);
    } catch (error) {
      console.error('Error fetching users:', error);
    }
  }, [token, user?.id]);

  // Initial setup for socket connection and global event listeners
  useEffect(() => {
    if (!token) return;

    // Fetch users
    fetchUsers();

    // Connect to Socket.IO
    chatService.connect(token);

    // Socket event listeners that should persist regardless of selected user
    const unsubscribeNewMessage = chatService.onNewMessage((message) => {
      // Add messages to the allMessagesRef
      const senderId = message.sender._id;
      allMessagesRef.current[senderId] = [...(allMessagesRef.current[senderId] || []), message];
      
      // If this is from the currently selected user, update the UI
      if (selectedUser && senderId === selectedUser._id) {
        setMessages((prev) => [...prev, message]);
        scrollToBottom();
      }
      
      // Update refresh timestamp to avoid unnecessary polling right after receiving a socket message
      setLastRefreshTime(Date.now());
    });

    const unsubscribeMessageSent = chatService.onMessageSent((message) => {
      // Add messages to the allMessagesRef
      const receiverId = message.receiver;
      allMessagesRef.current[receiverId] = [...(allMessagesRef.current[receiverId] || []), message];
      
      // Update UI for current conversation
      if (selectedUser && receiverId === selectedUser._id) {
        setMessages((prev) => [...prev, message]);
        scrollToBottom();
      }
      
      // Update refresh timestamp to avoid unnecessary polling right after sending a message
      setLastRefreshTime(Date.now());
    });

    const unsubscribeUserStatus = chatService.onUserStatus((data) => {
      console.log('User status change:', data);
      
      // Immediately update the user status in the current list
      setUsers((prev) =>
        prev.map((u) =>
          u._id === data.userId ? { ...u, online: data.status === 'online' } : u
        )
      );
      
      // Also refetch all users to get the latest status
      fetchUsers();
    });

    return () => {
      unsubscribeNewMessage();
      unsubscribeMessageSent();
      unsubscribeUserStatus();
      chatService.disconnect();
    };
  }, [token, selectedUser, fetchUsers]);

  // Setup typing listener which depends on selected user
  useEffect(() => {
    if (!token || !selectedUser) return;

    const unsubscribeUserTyping = chatService.onUserTyping((data) => {
      if (data.userId === selectedUser._id) {
        setTyping(`${data.username} is typing...`);
        if (typingTimeoutRef.current) {
          clearTimeout(typingTimeoutRef.current);
        }
        typingTimeoutRef.current = setTimeout(() => setTyping(''), 2000);
      }
    });

    return () => {
      unsubscribeUserTyping();
    };
  }, [token, selectedUser]);

  // Fetch message history when user is selected
  useEffect(() => {
    if (!token || !selectedUser) return;

    // Clear refresh interval when changing users
    if (refreshIntervalRef.current) {
      clearInterval(refreshIntervalRef.current);
    }
    
    isInitialLoadRef.current = true;

    // Fetch message history
    const fetchMessages = async () => {
      try {
        const response = await axios.get(
          `${API_URL}/api/messages/${selectedUser._id}`,
          {
            headers: { Authorization: `Bearer ${token}` }
          }
        );
        
        // Store in allMessagesRef for this user
        allMessagesRef.current[selectedUser._id] = response.data;
        
        // Update UI
        setMessages(response.data);
        scrollToBottom();
        
        // Update refresh timestamp
        setLastRefreshTime(Date.now());
        
        // Set initial load to false after first load
        isInitialLoadRef.current = false;
      } catch (error) {
        console.error('Error fetching messages:', error);
      }
    };

    // Check if we already have messages for this user in memory
    if (allMessagesRef.current[selectedUser._id]) {
      setMessages(allMessagesRef.current[selectedUser._id]);
      scrollToBottom();
      
      // We still fetch to make sure we have the latest messages
      fetchMessages();
    } else {
      fetchMessages();
    }
    
    // Set up polling for refreshing messages
    refreshIntervalRef.current = setInterval(() => {
      // Only poll if socket is not connected or has no recent activity
      if (!chatService.isConnected() || !chatService.hasRecentActivity(30000)) {
        fetchMessages();
      }
    }, 30000); // Increase poll interval to 30 seconds
    
    return () => {
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
      }
    };
  }, [token, selectedUser, lastRefreshTime]);

  // Add additional polling effect that runs less frequently as a backup to ensure data consistency
  useEffect(() => {
    if (!token) return;
    
    const backupRefreshInterval = setInterval(() => {
      // Skip if we're in initial load or no user is selected
      if (isInitialLoadRef.current || !selectedUser) return;
      
      // Force refresh data if it's been a long time (> 60 seconds) since last refresh
      if (Date.now() - lastRefreshTime > 60000) {
        const fetchLatestMessages = async () => {
          try {
            const response = await axios.get(
              `${API_URL}/api/messages/${selectedUser._id}`,
              {
                headers: { Authorization: `Bearer ${token}` }
              }
            );
            
            // If we have more messages on the server than locally
            if (response.data.length > (allMessagesRef.current[selectedUser._id]?.length || 0)) {
              allMessagesRef.current[selectedUser._id] = response.data;
              setMessages(response.data);
              scrollToBottom();
              setLastRefreshTime(Date.now());
            }
          } catch (error) {
            console.error('Error in backup refresh:', error);
          }
        };
        
        fetchLatestMessages();
      }
    }, 120000); // Run every 2 minutes
    
    return () => {
      clearInterval(backupRefreshInterval);
    };
  }, [token, selectedUser, lastRefreshTime]);

  // Add effect for message deletion socket listeners
  useEffect(() => {
    if (!token) return;

    // Handle when another user deletes a message
    const unsubscribeMessageDeleted = chatService.onMessageDeleted((data) => {
      setMessages((prev) => 
        prev.filter((message) => message._id !== data.messageId)
      );
      
      // Also update the allMessagesRef
      if (selectedUser) {
        allMessagesRef.current[selectedUser._id] = (allMessagesRef.current[selectedUser._id] || [])
          .filter((message) => message._id !== data.messageId);
      }
    });

    // Handle confirmation of our own message deletion
    const unsubscribeDeleteConfirmed = chatService.onMessageDeleteConfirmed((data) => {
      setMessages((prev) => 
        prev.filter((message) => message._id !== data.messageId)
      );
      
      // Also update the allMessagesRef
      if (selectedUser) {
        allMessagesRef.current[selectedUser._id] = (allMessagesRef.current[selectedUser._id] || [])
          .filter((message) => message._id !== data.messageId);
      }
    });

    return () => {
      unsubscribeMessageDeleted();
      unsubscribeDeleteConfirmed();
    };
  }, [token, selectedUser]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || !selectedUser) return;

    chatService.sendMessage(selectedUser._id, newMessage.trim());
    setNewMessage('');
  };

  const handleImageClick = () => {
    // Trigger the hidden file input
    fileInputRef.current?.click();
  };

  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || !e.target.files[0] || !selectedUser) return;

    try {
      const file = e.target.files[0];
      
      // Set the file for later upload
      setImageToUpload(file);
      
      // Create preview URL
      const previewUrl = URL.createObjectURL(file);
      setPreviewImage(previewUrl);
      
      // Open preview dialog
      setPreviewDialogOpen(true);
    } catch (error) {
      console.error('Error preparing image preview:', error);
    }
  };

  const handleSendImageAfterPreview = async () => {
    if (!imageToUpload || !selectedUser) return;

    try {
      setIsUploading(true);
      
      // Send the image
      await chatService.sendImageMessage(selectedUser._id, imageToUpload);
      
      // Reset the file input and close dialog
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      handleCancelImageUpload();
    } catch (error) {
      console.error('Error uploading image:', error);
    } finally {
      setIsUploading(false);
    }
  };

  const handleCancelImageUpload = () => {
    // Clean up preview URL to avoid memory leaks
    if (previewImage) {
      URL.revokeObjectURL(previewImage);
    }
    
    // Reset state
    setPreviewImage(null);
    setImageToUpload(null);
    setPreviewDialogOpen(false);
    
    // Reset the file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleTyping = () => {
    if (selectedUser) {
      chatService.sendTyping(selectedUser._id);
    }
  };

  const handleLogout = () => {
    // When socket disconnects, the server emits a 'user_status' event with status 'offline'
    // This is sent to all other connected clients so they know this user is now offline
    chatService.disconnect();
    logout();
    navigate('/login');
  };

  const handleUserSelect = (user: User) => {
    setSelectedUser(user);
    if (isMobile) {
      setDrawerOpen(false);
    }
  };

  // Create a separate component for image messages
  const ImageMessage = ({ messageId }: { messageId: string }) => {
    const [isLoading, setIsLoading] = useState(true);
    const [isError, setIsError] = useState(false);
    const [imageSrc, setImageSrc] = useState<string | null>(null);
    
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
    
    const isProblematicImage = problematicIds.includes(messageId);

    // Load the image in the background
    useEffect(() => {
      // Skip problematic images
      if (isProblematicImage) {
        setIsError(true);
        setIsLoading(false);
        return;
      }
      
      // Skip if no token
      if (!token) return;
      
      // Skip if already loaded from cache
      if (globalImageSrcCache.has(messageId)) {
        setImageSrc(globalImageSrcCache.get(messageId) || null);
        setIsLoading(false);
        return;
      }
      
      // Reference to check if component is still mounted
      let isMounted = true;
      
      // Fetch and load the image
      const loadImage = async () => {
        try {
          // Check if image is available
          const isAvailable = await chatService.checkAndPrefetchImage(messageId);
          
          // Skip if component unmounted
          if (!isMounted) return;
          
          if (isAvailable) {
            // Try to fetch the image
            const url = chatService.getImageUrl(messageId);
            const cacheBuster = `t=${Date.now()}&r=${Math.random()}`;
            
            const response = await fetch(`${url}?${cacheBuster}`, {
              headers: { Authorization: `Bearer ${token}` }
            });
            
            // Skip if component unmounted
            if (!isMounted) return;
            
            if (!response.ok) {
              throw new Error(`Failed to fetch image: ${response.status}`);
            }
            
            const blob = await response.blob();
            const blobUrl = URL.createObjectURL(blob);
            
            // Skip if component unmounted
            if (!isMounted) {
              URL.revokeObjectURL(blobUrl);
              return;
            }
            
            // Cache the image URL
            globalImageSrcCache.set(messageId, blobUrl);
            globalImageLoadedState.add(messageId);
            
            // Update state
            setImageSrc(blobUrl);
            setIsLoading(false);
          } else {
            // Image not available
            setIsError(true);
            setIsLoading(false);
          }
        } catch (error) {
          // Skip if component unmounted
          if (!isMounted) return;
          
          setIsError(true);
          setIsLoading(false);
        }
      };
      
      // Start loading the image
      loadImage();
      
      // Cleanup
      return () => {
        isMounted = false;
      };
    }, [messageId, token, isProblematicImage]);
    
    const handleRetry = () => {
      // Clear from caches
      globalImageSrcCache.delete(messageId);
      globalImageLoadedState.delete(messageId);
      chatService.clearImageCache(messageId);
      
      // Reset state to trigger a reload
      setIsLoading(true);
      setIsError(false);
      setImageSrc(null);
    };
    
    return (
      <Box sx={{ maxWidth: '250px', minHeight: '100px' }}>
        {isLoading && (
          <Box sx={{ 
            height: '150px', 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center',
            backgroundColor: '#f0f0f0',
            borderRadius: '4px'
          }}>
            <CircularProgress size={24} color="primary" sx={{ mr: 1 }} />
            <Typography variant="caption" color="textSecondary">Loading image...</Typography>
          </Box>
        )}
        
        {!isLoading && !isError && imageSrc && (
          <img 
            src={imageSrc}
            alt="Shared" 
            style={{ 
              maxWidth: '100%', 
              maxHeight: '200px', 
              borderRadius: '4px'
            }}
            onError={() => {
              setIsError(true);
              
              // Clean up blob URL if it exists
              if (imageSrc && imageSrc.startsWith('blob:')) {
                URL.revokeObjectURL(imageSrc);
              }
            }}
            loading="lazy"
          />
        )}
        
        {!isLoading && isError && (
          <Box sx={{ 
            padding: '20px',
            backgroundColor: '#f0f0f0',
            borderRadius: '4px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center'
          }}>
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
              <circle cx="8.5" cy="8.5" r="1.5"/>
              <polyline points="21 15 16 10 5 21"/>
            </svg>
            <Typography variant="caption" sx={{ mt: 1 }} color="textSecondary">Image unavailable</Typography>
            <Button 
              size="small"
              sx={{ mt: 1, fontSize: '0.7rem' }}
              onClick={handleRetry}
            >
              Retry
            </Button>
          </Box>
        )}
      </Box>
    );
  };

  // Modified message rendering to include long-press and right-click
  const renderMessage = (message: Message, index: number) => {
    const isOwnMessage = message.sender._id === user?.id;
    
    return (
      <Box
        key={`${message._id}-${index}`}
        sx={{
          display: 'flex',
          justifyContent: isOwnMessage ? 'flex-end' : 'flex-start',
          mb: 1,
          px: 1
        }}
        onTouchStart={handleMessageTouchStart(message)}
        onTouchEnd={handleMessageTouchEnd}
        onTouchMove={handleMessageTouchMove}
        onContextMenu={handleMessageContextMenu(message)}
      >
        <Paper
          elevation={1}
          sx={{
            p: 1,
            maxWidth: '70%',
            borderRadius: 2,
            backgroundColor: isOwnMessage ? '#DCF8C6' : '#F5F5F5',
            wordBreak: 'break-word'
          }}
        >
          {renderMessageContent(message)}
          <Typography variant="caption" display="block" sx={{ textAlign: 'right', mt: 0.5, color: 'rgba(0, 0, 0, 0.7)' }}>
            {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Typography>
        </Paper>
      </Box>
    );
  };

  // Modify the renderMessageContent function to use the component
  const renderMessageContent = (message: Message) => {
    if (message.messageType === 'image') {
      return <ImageMessage messageId={message._id} />;
    } else {
      return <Typography variant="body1" sx={{ color: '#000000', fontWeight: 500 }}>{message.content}</Typography>;
    }
  };

  // Handle long press on message
  const handleMessageTouchStart = (message: Message) => (event: React.TouchEvent) => {
    event.preventDefault();
    
    const timer = setTimeout(() => {
      setSelectedMessage(message);
      setDeleteDialogOpen(true);
    }, 500); // 500ms for long press
    
    setLongPressTimer(timer);
  };

  const handleMessageTouchEnd = () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      setLongPressTimer(null);
    }
  };

  const handleMessageTouchMove = () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      setLongPressTimer(null);
    }
  };

  // Handle right-click on message (for desktop)
  const handleMessageContextMenu = (message: Message) => (event: React.MouseEvent) => {
    event.preventDefault();
    setContextMenu({
      mouseX: event.clientX,
      mouseY: event.clientY,
      messageId: message._id
    });
  };

  const handleCloseContextMenu = () => {
    setContextMenu(null);
  };

  const handleDeleteFromContextMenu = () => {
    if (contextMenu && selectedUser) {
      const messageToDelete = messages.find(msg => msg._id === contextMenu.messageId);
      if (messageToDelete) {
        setSelectedMessage(messageToDelete);
        setDeleteDialogOpen(true);
      }
    }
    handleCloseContextMenu();
  };

  // Handle delete message confirmation
  const handleDeleteMessage = async () => {
    if (selectedMessage && selectedUser) {
      try {
        // Check if this message is owned by the current user
        const isOwnMessage = selectedMessage.sender._id === user?.id;
        
        if (!isOwnMessage) {
          setAlertMessage({
            type: 'error',
            message: 'You can only delete messages you sent'
          });
          setDeleteDialogOpen(false);
          setSelectedMessage(null);
          return;
        }
        
        // Show loading state if needed
        
        // Try to delete the message
        await chatService.deleteMessage(selectedMessage._id, selectedUser._id);
        
        // If successful, clear state and show feedback
        setDeleteDialogOpen(false);
        setSelectedMessage(null);
        setAlertMessage({
          type: 'success',
          message: 'Message deleted successfully'
        });
        
        // Remove the message from local state if socket events don't handle it
        setMessages(prev => 
          prev.filter(message => message._id !== selectedMessage._id)
        );
        
        // Also update allMessagesRef
        if (allMessagesRef.current[selectedUser._id]) {
          allMessagesRef.current[selectedUser._id] = allMessagesRef.current[selectedUser._id]
            .filter(message => message._id !== selectedMessage._id);
        }
        
      } catch (error: any) {
        console.error('Error deleting message:', error);
        setDeleteDialogOpen(false);
        
        // Show error message
        setAlertMessage({
          type: 'error',
          message: error.message || 'Failed to delete message. Please try again.'
        });
      }
    }
  };

  // Handle close alert
  const handleCloseAlert = () => {
    setAlertMessage(null);
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', overflow: 'hidden', bgcolor: 'background.default' }}>
      <AppBar position="static" sx={{ bgcolor: 'black' }}>
        <Toolbar>
          {isMobile && (
            <IconButton
              edge="start"
              color="primary"
              onClick={() => setDrawerOpen(!drawerOpen)}
              sx={{ mr: 2 }}
            >
              <MenuIcon />
            </IconButton>
          )}
          
          {isMobile && selectedUser && (
            <IconButton
              edge="start"
              color="primary"
              onClick={() => setSelectedUser(null)}
              sx={{ mr: 2 }}
            >
              <ArrowBackIcon />
            </IconButton>
          )}

          <Typography variant="h6" component="div" sx={{ 
            flexGrow: 1, 
            color: 'primary.main', 
            fontWeight: 'bold',
            textAlign: isMobile ? 'center' : 'left',
            fontSize: isMobile ? '1.1rem' : '1.25rem'
          }}>
            {isMobile && selectedUser ? selectedUser.username : 'MyChat'}
          </Typography>
          
          {!isMobile && (
            <Typography variant="body1" sx={{ mr: 2, color: 'primary.light' }}>
              Hello, {user?.username}
            </Typography>
          )}
          
          <Button 
            color="primary" 
            onClick={handleLogout}
            startIcon={!isMobile && <LogoutIcon />}
            sx={{ 
              borderRadius: '20px', 
              px: isMobile ? 1 : 2,
              minWidth: isMobile ? '40px' : 'auto',
              '& .MuiButton-startIcon': {
                margin: isMobile ? 0 : undefined
              }
            }}
          >
            {isMobile ? <LogoutIcon /> : 'Logout'}
          </Button>
        </Toolbar>
      </AppBar>

      {isMobile ? (
        <>
          <Drawer
            anchor="left"
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            PaperProps={{
              sx: {
                width: '80%',
                maxWidth: '300px',
                bgcolor: 'background.paper',
              }
            }}
          >
            <Box sx={{ p: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
              <Typography variant="h6" sx={{ color: 'primary.main' }}>
                Users
              </Typography>
            </Box>
            <List sx={{ width: '100%' }}>
              {users
                .filter(u => String(u._id) !== String(user?.id))
                .map(u => (
                  <React.Fragment key={u._id}>
                    <ListItemButton
                      selected={selectedUser?._id === u._id}
                      onClick={() => handleUserSelect(u)}
                      sx={{ 
                        '&.Mui-selected': {
                          bgcolor: 'rgba(255, 215, 0, 0.15)', 
                          '&:hover': { bgcolor: 'rgba(255, 215, 0, 0.25)' }
                        },
                        '&:hover': { bgcolor: 'rgba(255, 255, 255, 0.05)' }
                      }}
                    >
                      <ListItemText
                        primary={
                          <Box sx={{ display: 'flex', alignItems: 'center' }}>
                            <Badge
                              color="success"
                              variant="dot"
                              invisible={!u.online}
                              sx={{ mr: 1 }}
                            />
                            {u.username}
                          </Box>
                        }
                      />
                    </ListItemButton>
                    <Divider sx={{ bgcolor: 'divider' }} />
                  </React.Fragment>
                ))}
            </List>
          </Drawer>
          
          <Box sx={{ 
            flexGrow: 1, 
            display: 'flex', 
            flexDirection: 'column',
            height: 'calc(100vh - 56px)',
            overflow: 'hidden'
          }}>
            {selectedUser ? (
              <Box sx={{ 
                display: 'flex', 
                flexDirection: 'column',
                height: '100%',
                overflow: 'hidden'
              }}>
                {/* Messages */}
                <Box sx={{ 
                  flexGrow: 1, 
                  overflow: 'auto', 
                  p: 2,
                  backgroundImage: 'linear-gradient(rgba(0, 0, 0, 0.6), rgba(0, 0, 0, 0.8))',
                }}>
                  {messages.map((message, index) => renderMessage(message, index))}
                  <div ref={messagesEndRef} />
                </Box>

                {/* Typing Indicator */}
                {typing && (
                  <Typography
                    variant="caption"
                    sx={{ px: 2, py: 1, color: 'primary.light', fontStyle: 'italic' }}
                  >
                    {typing}
                  </Typography>
                )}

                {/* Message Input */}
                <Box
                  component="form"
                  onSubmit={handleSendMessage}
                  sx={{ p: 1.5, backgroundColor: 'secondary.dark', borderTop: '1px solid', borderColor: 'divider' }}
                >
                  <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 5fr) minmax(0, 1fr)', gap: 1, alignItems: 'center' }}>
                    <Box>
                      <TextField
                        fullWidth
                        size="small"
                        placeholder="Type a message..."
                        value={newMessage}
                        onChange={(e) => {
                          setNewMessage(e.target.value);
                          handleTyping();
                        }}
                        onKeyPress={handleTyping}
                        InputProps={{
                          sx: {
                            borderRadius: '20px',
                            backgroundColor: '#FFFFFF',
                            color: '#000000',
                            '& .MuiOutlinedInput-notchedOutline': {
                              borderColor: 'divider',
                            },
                            '&:hover .MuiOutlinedInput-notchedOutline': {
                              borderColor: 'primary.main',
                            },
                            '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
                              borderColor: 'primary.main',
                            },
                            '& input::placeholder': {
                              color: 'rgba(0, 0, 0, 0.6)'
                            }
                          },
                          endAdornment: (
                            <InputAdornment position="end">
                              <IconButton
                                onClick={handleImageClick}
                                disabled={isUploading}
                                edge="end"
                                sx={{ color: 'primary.main' }}
                              >
                                <ImageIcon />
                              </IconButton>
                              <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/*"
                                style={{ display: 'none' }}
                                onChange={handleImageSelect}
                              />
                            </InputAdornment>
                          ),
                        }}
                      />
                    </Box>
                    <Box sx={{ display: "flex", justifyContent: "center" }}>
                      <IconButton
                        color="primary"
                        type="submit"
                        disabled={!newMessage.trim() || isUploading}
                        sx={{ 
                          bgcolor: 'primary.main', 
                          color: 'primary.contrastText',
                          '&:hover': { bgcolor: 'primary.dark' },
                          '&.Mui-disabled': { bgcolor: 'rgba(255, 215, 0, 0.3)' }
                        }}
                      >
                        <SendIcon />
                      </IconButton>
                    </Box>
                  </Box>
                </Box>
              </Box>
            ) : (
              <Box
                sx={{
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexDirection: 'column',
                  p: 2,
                  backgroundImage: 'linear-gradient(rgba(0, 0, 0, 0.7), rgba(0, 0, 0, 0.9))',
                  borderRadius: '10px'
                }}
              >
                <Typography variant="h5" color="primary.main" sx={{ mb: 2, fontWeight: 'bold', textAlign: 'center' }}>
                  Welcome to MyChat
                </Typography>
                <Typography variant="body1" color="text.secondary" sx={{ textAlign: 'center' }}>
                  {isMobile ? 'Tap the menu icon to select a user' : 'Select a user to start chatting'}
                </Typography>
              </Box>
            )}
          </Box>
        </>
      ) : (
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '3fr 9fr' }, gap: 2, flexGrow: 1, p: 2, height: 'calc(100vh - 64px)' }}>
          {/* Users List */}
          <Box sx={{ height: '100%' }}>
            <Paper sx={{ 
              height: '100%', 
              overflow: 'auto', 
              bgcolor: 'background.paper', 
              borderRadius: '10px',
              border: '1px solid',
              borderColor: 'divider'
            }}>
              <List>
                {users
                  .filter((u) => String(u._id) !== String(user?.id))
                  .map((u) => (
                    <React.Fragment key={u._id}>
                      <ListItemButton
                        selected={selectedUser?._id === u._id}
                        onClick={() => setSelectedUser(u)}
                        sx={{ 
                          '&.Mui-selected': {
                            bgcolor: 'rgba(255, 215, 0, 0.15)', 
                            '&:hover': { bgcolor: 'rgba(255, 215, 0, 0.25)' }
                          },
                          '&:hover': { bgcolor: 'rgba(255, 255, 255, 0.05)' }
                        }}
                      >
                        <ListItemText
                          primary={
                            <Box sx={{ display: 'flex', alignItems: 'center' }}>
                              <Badge
                                color="success"
                                variant="dot"
                                invisible={!u.online}
                                sx={{ mr: 1 }}
                              />
                              {u.username}
                            </Box>
                          }
                        />
                      </ListItemButton>
                      <Divider sx={{ bgcolor: 'divider' }} />
                    </React.Fragment>
                  ))}
              </List>
            </Paper>
          </Box>

          {/* Chat Area */}
          <Box sx={{ height: '100%' }}>
            <Paper sx={{ 
              height: '100%', 
              display: 'flex', 
              flexDirection: 'column',
              borderRadius: '10px',
              bgcolor: 'background.paper',
              border: '1px solid',
              borderColor: 'divider'
            }}>
              {selectedUser ? (
                <>
                  {/* Messages */}
                  <Box sx={{ 
                    flexGrow: 1, 
                    overflow: 'auto', 
                    p: 2,
                    backgroundImage: 'linear-gradient(rgba(0, 0, 0, 0.6), rgba(0, 0, 0, 0.8))',
                  }}>
                    {messages.map((message, index) => renderMessage(message, index))}
                    <div ref={messagesEndRef} />
                  </Box>

                  {/* Typing Indicator */}
                  {typing && (
                    <Typography
                      variant="caption"
                      sx={{ px: 2, py: 1, color: 'primary.light', fontStyle: 'italic' }}
                    >
                      {typing}
                    </Typography>
                  )}

                  {/* Message Input */}
                  <Box
                    component="form"
                    onSubmit={handleSendMessage}
                    sx={{ p: 2, backgroundColor: 'secondary.dark', borderTop: '1px solid', borderColor: 'divider' }}
                  >
                    <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 11fr) minmax(0, 1fr)', gap: 1 }}>
                      <Box>
                        <TextField
                          fullWidth
                          size="small"
                          placeholder="Type a message..."
                          value={newMessage}
                          onChange={(e) => {
                            setNewMessage(e.target.value);
                            handleTyping();
                          }}
                          onKeyPress={handleTyping}
                          InputProps={{
                            sx: {
                              borderRadius: '20px',
                              backgroundColor: '#FFFFFF',
                              color: '#000000',
                              '& .MuiOutlinedInput-notchedOutline': {
                                borderColor: 'divider',
                              },
                              '&:hover .MuiOutlinedInput-notchedOutline': {
                                borderColor: 'primary.main',
                              },
                              '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
                                borderColor: 'primary.main',
                              },
                              '& input::placeholder': {
                                color: 'rgba(0, 0, 0, 0.6)'
                              }
                            },
                            endAdornment: (
                              <InputAdornment position="end">
                                <IconButton
                                  onClick={handleImageClick}
                                  disabled={isUploading}
                                  edge="end"
                                  sx={{ color: 'primary.main' }}
                                >
                                  <ImageIcon />
                                </IconButton>
                                <input
                                  ref={fileInputRef}
                                  type="file"
                                  accept="image/*"
                                  style={{ display: 'none' }}
                                  onChange={handleImageSelect}
                                />
                              </InputAdornment>
                            ),
                          }}
                        />
                      </Box>
                      <Box>
                        <IconButton
                          color="primary"
                          type="submit"
                          disabled={!newMessage.trim() || isUploading}
                          sx={{ 
                            bgcolor: 'primary.main', 
                            color: 'primary.contrastText',
                            '&:hover': { bgcolor: 'primary.dark' },
                            '&.Mui-disabled': { bgcolor: 'rgba(255, 215, 0, 0.3)' }
                          }}
                        >
                          <SendIcon />
                        </IconButton>
                      </Box>
                    </Box>
                  </Box>
                </>
              ) : (
                <Box
                  sx={{
                    height: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexDirection: 'column',
                    backgroundImage: 'linear-gradient(rgba(0, 0, 0, 0.7), rgba(0, 0, 0, 0.9))',
                    borderRadius: '10px'
                  }}
                >
                  <Typography variant="h5" color="primary.main" sx={{ mb: 2, fontWeight: 'bold' }}>
                    Welcome to MyChat
                  </Typography>
                  <Typography variant="body1" color="text.secondary">
                    Select a user to start chatting
                  </Typography>
                </Box>
              )}
            </Paper>
          </Box>
        </Box>
      )}

      {/* Image Preview Dialog */}
      <Dialog 
        open={previewDialogOpen} 
        onClose={handleCancelImageUpload}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography variant="h6">Image Preview</Typography>
          <IconButton edge="end" onClick={handleCancelImageUpload}>
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          {previewImage && (
            <Box 
              sx={{ 
                display: 'flex', 
                justifyContent: 'center', 
                my: 2,
                maxHeight: '60vh',
                overflow: 'hidden'
              }}
            >
              <img 
                src={previewImage} 
                alt="Preview" 
                style={{ 
                  maxWidth: '100%', 
                  maxHeight: '60vh', 
                  objectFit: 'contain',
                  borderRadius: '4px'
                }} 
              />
            </Box>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2, pt: 1 }}>
          <Button 
            onClick={handleCancelImageUpload} 
            color="error" 
            variant="outlined"
            disabled={isUploading}
          >
            Cancel
          </Button>
          <Button 
            onClick={handleSendImageAfterPreview} 
            color="primary" 
            variant="contained"
            disabled={isUploading}
            startIcon={isUploading ? null : <SendIcon />}
          >
            {isUploading ? 'Sending...' : 'Send'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Context Menu */}
      <Menu
        open={contextMenu !== null}
        onClose={handleCloseContextMenu}
        anchorReference="anchorPosition"
        anchorPosition={
          contextMenu !== null
            ? { top: contextMenu.mouseY, left: contextMenu.mouseX }
            : undefined
        }
      >
        <MenuItem onClick={handleDeleteFromContextMenu} sx={{ color: 'error.main' }}>
          <DeleteIcon fontSize="small" sx={{ mr: 1 }} />
          Delete Message
        </MenuItem>
      </Menu>
      
      {/* Delete Message Dialog */}
      <Dialog
        open={deleteDialogOpen}
        onClose={() => setDeleteDialogOpen(false)}
      >
        <DialogTitle>Delete Message</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to delete this message? This action cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleDeleteMessage} color="error" autoFocus>
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* Alert Snackbar */}
      {alertMessage && (
        <Snackbar 
          open={true} 
          autoHideDuration={5000}
          onClose={handleCloseAlert}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        >
          <Alert 
            onClose={handleCloseAlert} 
            severity={alertMessage.type} 
            variant="filled"
            sx={{ width: '100%' }}
          >
            {alertMessage.message}
          </Alert>
        </Snackbar>
      )}
    </Box>
  );
};

export default Chat; 