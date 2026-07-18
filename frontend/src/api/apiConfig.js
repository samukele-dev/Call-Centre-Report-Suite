// src/services/apiConfig.js - COMPLETE UPDATED VERSION
import axios from 'axios';

// Base URL for your Django API
const API_BASE_URL = 'http://localhost:8000';

// Create axios instance
const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor to add token
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('authToken');
    if (token) {
      config.headers['Authorization'] = `Token ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor for error handling
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response && error.response.status === 401) {
      localStorage.removeItem('authToken');
      localStorage.removeItem('user');
      
      if (!window.location.pathname.includes('/login')) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

// Export helper functions for headers
export const getHeaders = () => {
  const token = localStorage.getItem('authToken');
  const headers = {
    'Content-Type': 'application/json',
  };
  
  if (token) {
    headers['Authorization'] = `Token ${token}`;
  }
  
  return headers;
};

export const getMultipartHeaders = () => {
  const token = localStorage.getItem('authToken');
  const headers = {
    'Content-Type': 'multipart/form-data',
  };
  
  if (token) {
    headers['Authorization'] = `Token ${token}`;
  }
  
  return headers;
};

// API functions for dashboard operations
export const dashboardAPI = {
  // Auth endpoints
  login: async (username, password) => {
    try {
      const response = await api.post('/api/api-token-auth/', { username, password });
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Login error:', error);
      return {
        success: false,
        error: error.response?.data || 'Login failed'
      };
    }
  },

  register: async (userData) => {
    try {
      const response = await api.post('/api/register/', userData);
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Register error:', error);
      return {
        success: false,
        error: error.response?.data || 'Registration failed'
      };
    }
  },

  verifyToken: async () => {
    try {
      const response = await api.get('/api/verify-token/');
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Verify token error:', error);
      return {
        success: false,
        error: error.response?.data || 'Token verification failed'
      };
    }
  },

  // File upload
  uploadFile: async (file, delimiter = ',', hasHeaders = true) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('delimiter', delimiter);
    formData.append('has_headers', hasHeaders.toString());

    try {
      const response = await api.post('/api/files/', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Upload error:', error);
      return {
        success: false,
        error: error.response?.data?.error || error.response?.data || 'Upload failed'
      };
    }
  },

  // Get dashboard stats
  getDashboardStats: async () => {
    try {
      const response = await api.get('/api/stats/');
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Dashboard stats error:', error);
      return {
        success: false,
        error: error.response?.data?.error || error.response?.data || 'Failed to load stats'
      };
    }
  },

  // Get call data files
  getCallDataFiles: async () => {
    try {
      const response = await api.get('/api/files/');
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Get files error:', error);
      return {
        success: false,
        error: error.response?.data?.error || error.response?.data || 'Failed to load files'
      };
    }
  },

  // Preview processed data
  previewFile: async (fileId) => {
    try {
      const response = await api.get(`/api/files/${fileId}/preview/`);
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Preview error:', error.response || error);
      return { 
        success: false, 
        error: error.response?.data || error.message 
      };
    }
  },

  // DOWNLOAD PROCESSED FILE (from uploads)
  downloadProcessedFile: async (fileId) => {
    try {
      const response = await api.get(`/api/files/${fileId}/download_processed/`, {
        responseType: 'blob',
      });
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Download processed file error:', error);
      return {
        success: false,
        error: error.response?.data?.error || error.response?.data || 'Failed to download file'
      };
    }
  },

  // Outcome descriptions
  getOutcomeDescriptions: async () => {
    try {
      const response = await api.get('/api/outcomes/');
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Outcomes error:', error);
      return {
        success: false,
        error: error.response?.data?.error || error.response?.data || 'Failed to load outcomes'
      };
    }
  },

  // Generate main report
  generateCampaignReport: async () => {
    try {
      const response = await api.post('/api/reports/generate_campaign/');
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Generate campaign report error:', error);
      return {
        success: false,
        error: error.response?.data?.error || error.response?.data || 'Failed to generate report'
      };
    }
  },

  // Get generated reports
  getReports: async () => {
    try {
      const response = await api.get('/api/reports/');
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Get reports error:', error);
      return {
        success: false,
        error: error.response?.data?.error || error.response?.data || 'Failed to load reports'
      };
    }
  },

  // DOWNLOAD GENERATED REPORT (campaign analysis)
  downloadReport: async (reportId) => {
    try {
      const response = await api.get(`/api/reports/${reportId}/download/`, {
        responseType: 'blob',
      });
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Download report error:', error);
      return {
        success: false,
        error: error.response?.data?.error || error.response?.data || 'Failed to download report'
      };
    }
  },

  // Setup test user
  setupTestUser: async () => {
    try {
      const response = await api.get('/api/setup-test-user/');
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Setup test user error:', error);
      return {
        success: false,
        error: error.response?.data?.error || error.response?.data || 'Failed to setup test user'
      };
    }
  },

  // Test upload
  testUpload: async (file) => {
    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await api.post('/api/test-upload/', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Test upload error:', error);
      return {
        success: false,
        error: error.response?.data?.error || error.response?.data || 'Test upload failed'
      };
    }
  },

  // Bulk upload outcomes
  bulkUploadOutcomes: async (file) => {
    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await api.post('/api/outcomes/bulk_upload/', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Bulk upload error:', error);
      return {
        success: false,
        error: error.response?.data?.error || error.response?.data || 'Bulk upload failed'
      };
    }
  },

  // Export outcomes
  exportOutcomes: async () => {
    try {
      const response = await api.get('/api/outcomes/export/', {
        responseType: 'blob',
      });
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Export outcomes error:', error);
      return {
        success: false,
        error: error.response?.data?.error || error.response?.data || 'Failed to export outcomes'
      };
    }
  },
};

// Test connection
export const testConnection = async () => {
  try {
    await api.get('/api/stats/');
    return true;
  } catch (error) {
    console.error('Connection test failed:', error);
    return false;
  }
};

export default api;