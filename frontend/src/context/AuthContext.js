// AuthContext.js - FIXED VERSION (tries multiple endpoints)
import React, { createContext, useState, useContext, useEffect } from 'react';
import axios from 'axios';

// Create the context
const AuthContext = createContext({});

// API Base URL
const API_BASE_URL = 'http://localhost:8000';

export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [authError, setAuthError] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [apiPrefix, setApiPrefix] = useState(''); // Will store '/api/' or ''

  // Detect API prefix on mount
  useEffect(() => {
    const detectApiPrefix = async () => {
      const endpoints = [
        '/api-token-auth/',           // No prefix
        '/api/api-token-auth/',       // With /api/ prefix
      ];
      
      for (const endpoint of endpoints) {
        try {
          const response = await axios.get(`${API_BASE_URL}${endpoint}`);
          console.log(`✅ Found endpoint: ${endpoint}`);
          // Extract prefix
          const prefix = endpoint.replace('api-token-auth/', '');
          setApiPrefix(prefix);
          break;
        } catch (error) {
          console.log(`❌ Not found: ${endpoint}`);
        }
      }
      
      setIsLoading(false);
    };

    detectApiPrefix();
  }, []);

  // Initialize auth state from localStorage
  useEffect(() => {
    const token = localStorage.getItem('authToken');
    const storedUser = localStorage.getItem('user');
    
    if (token && storedUser) {
      try {
        const parsedUser = JSON.parse(storedUser);
        setUser(parsedUser);
      } catch (error) {
        console.error('Error parsing stored user:', error);
        logout();
      }
    }
  }, []);

  // Login function - tries multiple endpoints
  const login = async (username, password) => {
    setAuthError(null);
    setIsLoading(true);
    
    // Try different endpoint possibilities
    const endpoints = [
      '/api-token-auth/',
    ];
    
    for (const endpoint of endpoints) {
      try {
        console.log(`🔍 Trying login endpoint: ${API_BASE_URL}${endpoint}`);
        
        const response = await axios.post(`${API_BASE_URL}${endpoint}`, {
          username,
          password
        }, { timeout: 5000 });

        console.log(`✅ Login successful with endpoint: ${endpoint}`);
        console.log('Login response:', response.data);
        
        if (!response.data.token) {
          console.warn('No token in response:', response.data);
          continue; // Try next endpoint
        }
        
        const { token, user_id, username: userUsername, email } = response.data;
        
        // Store token and user info
        localStorage.setItem('authToken', token);
        
        const userData = {
          id: user_id,
          username: userUsername,
          email: email || '',
          token: token
        };
        
        localStorage.setItem('user', JSON.stringify(userData));
        setUser(userData);
        setAuthError(null);
        
        setIsLoading(false);
        return { success: true, data: userData };
        
      } catch (error) {
        console.log(`❌ Failed with endpoint ${endpoint}:`, 
          error.response?.status || error.message);
        // Continue to next endpoint
      }
    }
    
    // If we get here, all endpoints failed
    const errorMessage = 'Login failed. Possible issues:\n' +
      '1. Backend is not running\n' +
      '2. URL endpoint is incorrect\n' +
      '3. Test user does not exist\n\n' +
      'Try: http://localhost:8000/setup-test-user/ to create test user';
    
    setAuthError(errorMessage);
    setIsLoading(false);
    return { success: false, error: errorMessage };
  };

  // Verify token validity
  const verifyToken = async (token) => {
    const endpoints = [
      '/verify-token/',
      '/api/verify-token/',
    ];
    
    for (const endpoint of endpoints) {
      try {
        const response = await axios.get(`${API_BASE_URL}${endpoint}`, {
          headers: { 'Authorization': `Token ${token}` },
          timeout: 3000
        });
        return response.data.valid === true;
      } catch (error) {
        console.log(`Token verification failed with ${endpoint}:`, error.message);
      }
    }
    return false;
  };

  // Create axios instance with auth token
  const getAuthHeaders = () => {
    const token = localStorage.getItem('authToken');
    return {
      headers: {
        'Authorization': token ? `Token ${token}` : '',
        'Content-Type': 'application/json',
      }
    };
  };

  // Logout function
  const logout = () => {
    localStorage.removeItem('authToken');
    localStorage.removeItem('user');
    setUser(null);
    setAuthError(null);
  };

  // Register function
  const register = async (userData) => {
    setAuthError(null);
    setIsLoading(true);
    
    const endpoints = [
      '/register/',
      '/api/register/',
    ];
    
    for (const endpoint of endpoints) {
      try {
        const response = await axios.post(`${API_BASE_URL}${endpoint}`, userData, { timeout: 5000 });
        
        const { token, user_id, username: userUsername, email } = response.data;
        
        localStorage.setItem('authToken', token);
        
        const newUser = {
          id: user_id,
          username: userUsername,
          email: email,
          token: token
        };
        
        localStorage.setItem('user', JSON.stringify(newUser));
        setUser(newUser);
        setAuthError(null);
        
        setIsLoading(false);
        return { success: true, data: newUser };
        
      } catch (error) {
        console.log(`Registration failed with ${endpoint}:`, error.message);
      }
    }
    
    const errorMessage = 'Registration failed. Please try again.';
    setAuthError(errorMessage);
    setIsLoading(false);
    return { success: false, error: errorMessage };
  };

  // Check if user is authenticated
  const isAuthenticated = () => {
    const token = localStorage.getItem('authToken');
    const storedUser = localStorage.getItem('user');
    return !!token && !!storedUser && !!user;
  };

  // Get auth token
  const getToken = () => {
    return localStorage.getItem('authToken');
  };

  // Clear auth error
  const clearError = () => {
    setAuthError(null);
  };

  // Get API prefix
  const getApiPrefix = () => apiPrefix;

  return (
    <AuthContext.Provider
      value={{
        user,
        authError,
        isLoading,
        login,
        logout,
        register,
        isAuthenticated,
        getToken,
        getAuthHeaders,
        setAuthError,
        clearError,
        getApiPrefix,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};