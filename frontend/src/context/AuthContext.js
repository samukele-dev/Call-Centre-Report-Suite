// AuthContext.js - FIXED VERSION (tries multiple endpoints)
import React, { createContext, useState, useContext, useEffect } from 'react';
import axios from 'axios';

// Create the context
const AuthContext = createContext({});

// API Base URL — see apiConfig.js's identical fallback for why: CRA bakes
// REACT_APP_* env vars in at build time, Render's render.yaml sets this to
// the deployed backend's URL for the frontend build step, and it falls
// back to localhost so local `npm start` needs no env var at all.
const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:8000';

export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [authError, setAuthError] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  // Initialize auth state from localStorage. (This used to be preceded by a
  // probe that GET-ed /api-token-auth/ and /api/api-token-auth/ to "detect"
  // an API prefix. That endpoint is POST-only, so every probe was a 405 and
  // the detected prefix was never used — but each GET still counted against
  // the endpoint's 10/minute login throttle, so a few page refreshes could
  // eat into real login attempts. isLoading now flips off here instead.)
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
    setIsLoading(false);
  }, []);

  // Login function - tries multiple endpoints
  const login = async (username, password) => {
    setAuthError(null);
    setIsLoading(true);
    
    // Try different endpoint possibilities
    const endpoints = [
      '/api-token-auth/',
    ];
    let failureStatus = null;

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
        failureStatus = error.response?.status || null;
        console.log(`❌ Failed with endpoint ${endpoint}:`,
          failureStatus || error.message);
        // Continue to next endpoint
      }
    }

    // If we get here, all endpoints failed. A 400 from DRF's obtain-token
    // view means the server was reached and rejected the credentials.
    let errorMessage;
    if (failureStatus === 400 || failureStatus === 401) {
      errorMessage = 'Incorrect username or password.';
    } else if (failureStatus === 429) {
      errorMessage = 'Too many login attempts. Wait a minute and try again.';
    } else {
      errorMessage = 'Login failed. Possible issues:\n' +
        '1. Backend is not running\n' +
        '2. URL endpoint is incorrect\n' +
        '3. That user does not exist yet (see backend/create_test_user.py — ' +
        'TEST_USER_PASSWORD must be set for it to create one)';
    }
    
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
  const getApiPrefix = () => '';

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