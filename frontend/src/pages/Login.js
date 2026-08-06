// src/pages/Login.js
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const Login = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const { login, authError, isAuthenticated } = useAuth();
  const navigate = useNavigate();

  // Redirect if already authenticated
  React.useEffect(() => {
    if (isAuthenticated()) {
      navigate('/');
    }
  }, [isAuthenticated, navigate]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsLoading(true);

    const result = await login(username, password);

    if (result.success) {
      navigate('/');
    }

    setIsLoading(false);
  };

  // Pre-fill with test credentials for easy testing
  const useTestCredentials = () => {
    setUsername('test');
    setPassword('test123');
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-header">
          <div className="login-brand-icon">
            <i className="bi bi-telephone-fill"></i>
          </div>
          <h2>Call Center Reporting Suite</h2>
          <p className="text-muted mb-0">Sign in to your account</p>
        </div>

        {authError && (
          <div className="alert alert-danger" role="alert" style={{ whiteSpace: 'pre-line' }}>
            <i className="bi bi-exclamation-triangle me-2"></i>
            {authError}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="mb-3">
            <label htmlFor="username" className="form-label">
              <i className="bi bi-person me-2"></i>
              Username
            </label>
            <input
              type="text"
              className="form-control"
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              disabled={isLoading}
              placeholder="Enter username"
            />
          </div>

          <div className="mb-3">
            <label htmlFor="password" className="form-label">
              <i className="bi bi-lock me-2"></i>
              Password
            </label>
            <input
              type="password"
              className="form-control"
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={isLoading}
              placeholder="Enter password"
            />
          </div>

          <div className="d-grid gap-2 mb-3">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isLoading}
            >
              {isLoading ? (
                <>
                  <span className="spinner-border spinner-border-sm me-2"></span>
                  Signing in...
                </>
              ) : (
                <>
                  <i className="bi bi-box-arrow-in-right me-2"></i>
                  Sign In
                </>
              )}
            </button>

            {/* Test credentials button */}
            <button
              type="button"
              className="btn btn-outline-secondary"
              onClick={useTestCredentials}
              disabled={isLoading}
            >
              <i className="bi bi-speedometer2 me-2"></i>
              Use Test Credentials
            </button>
          </div>
        </form>

        <div className="text-center mt-4">
          <small className="text-muted">
            <strong>Test Credentials:</strong><br />
            Username: <code>test</code><br />
            Password: <code>test123</code>
          </small>
        </div>
      </div>
    </div>
  );
};

export default Login;
