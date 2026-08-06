import axios from 'axios';
import API_BASE_URL, { setAuthToken, removeAuthToken } from './apiConfig';

class AuthService {
  // Login user
  static async login(username, password) {
    try {
      const response = await axios.post(`${API_BASE_URL}/api-token-auth/`, {
        username,
        password
      });
      
      if (response.data.token) {
        setAuthToken(response.data.token);
        return { success: true, data: response.data };
      }
      
      return { success: false, error: 'No token received' };
    } catch (error) {
      return { 
        success: false, 
        error: error.response?.data?.message || 'Login failed' 
      };
    }
  }

  // Logout user
  static logout() {
    removeAuthToken();
  }

  // Register user (if needed)
  static async register(userData) {
    try {
      const response = await axios.post(`${API_BASE_URL}/register/`, userData);
      return { success: true, data: response.data };
    } catch (error) {
      return { 
        success: false, 
        error: error.response?.data?.message || 'Registration failed' 
      };
    }
  }

  // Check if user is authenticated
  static isAuthenticated() {
    return !!localStorage.getItem('authToken');
  }
}

export default AuthService;