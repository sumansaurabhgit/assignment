import React, { useState, useCallback } from 'react';
import axios from 'axios';

/**
 * Voicemail Detection Frontend
 * 
 * A simple React application for uploading WAV files and analyzing
 * them to detect the optimal timestamp for starting a voicemail message.
 * 
 * Features:
 * - Drag and drop file upload
 * - File validation (WAV only)
 * - Real-time analysis progress
 * - Detailed results display
 * - Debug information toggle
 */

function App() {
  // State management
  const [selectedFile, setSelectedFile] = useState(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [useMock, setUseMock] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  /**
   * Handles file selection from input or drag/drop
   */
  const handleFileSelect = useCallback((file) => {
    // Reset previous results
    setResult(null);
    setError(null);

    // Validate file type
    if (!file.name.toLowerCase().endsWith('.wav')) {
      setError('Please upload a WAV file');
      return;
    }

    // Validate file size (max 50MB)
    if (file.size > 50 * 1024 * 1024) {
      setError('File too large. Maximum size is 50MB.');
      return;
    }

    setSelectedFile(file);
  }, []);

  /**
   * Handles file input change
   */
  const handleInputChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      handleFileSelect(file);
    }
  };

  /**
   * Handles drag events
   */
  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDragEnter = (e) => {
    handleDrag(e);
    setDragOver(true);
  };

  const handleDragLeave = (e) => {
    handleDrag(e);
    setDragOver(false);
  };

  const handleDrop = (e) => {
    handleDrag(e);
    setDragOver(false);

    const file = e.dataTransfer.files[0];
    if (file) {
      handleFileSelect(file);
    }
  };

  /**
   * Removes the selected file
   */
  const handleRemoveFile = () => {
    setSelectedFile(null);
    setResult(null);
    setError(null);
  };

  /**
   * Analyzes the selected audio file
   */
  const handleAnalyze = async () => {
    if (!selectedFile) return;

    setIsAnalyzing(true);
    setError(null);
    setResult(null);

    try {
      // Create form data for file upload
      const formData = new FormData();
      formData.append('audio', selectedFile);

      // Build URL with mock parameter if enabled
      const url = useMock ? '/api/analyze?useMock=true' : '/api/analyze';

      // Send to backend
      const response = await axios.post(url, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });

      if (response.data.success) {
        setResult(response.data);
      } else {
        setError(response.data.error || 'Analysis failed');
      }
    } catch (err) {
      console.error('Analysis error:', err);
      setError(
        err.response?.data?.error || 
        err.message || 
        'Failed to analyze audio file'
      );
    } finally {
      setIsAnalyzing(false);
    }
  };

  /**
   * Formats file size for display
   */
  const formatFileSize = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  /**
   * Gets the display name for a detection reason
   */
  const getReasonDisplay = (reason) => {
    const displays = {
      beep: '🔔 Beep Detected',
      llm_silence: '🤖 LLM + Silence',
      silence_fallback: '🔇 Silence Fallback',
    };
    return displays[reason] || reason;
  };

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <h1>🎙️ Voicemail Detection</h1>
        <p>Detect the optimal timestamp to start a compliant voicemail message</p>
      </header>

      {/* Upload Section */}
      <section className="upload-section">
        <div
          className={`drop-zone ${dragOver ? 'drag-over' : ''}`}
          onDragEnter={handleDragEnter}
          onDragOver={handleDrag}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => document.getElementById('fileInput').click()}
        >
          <div className="drop-zone-icon">📁</div>
          <h3>Drop your WAV file here</h3>
          <p>or click to browse</p>
          <input
            id="fileInput"
            type="file"
            className="file-input"
            accept=".wav,audio/wav"
            onChange={handleInputChange}
          />
        </div>

        {/* Selected File Display */}
        {selectedFile && (
          <div className="selected-file">
            <div className="file-info">
              <span className="file-icon">🎵</span>
              <div className="file-details">
                <h4>{selectedFile.name}</h4>
                <p>{formatFileSize(selectedFile.size)}</p>
              </div>
            </div>
            <button className="remove-file" onClick={handleRemoveFile}>
              Remove
            </button>
          </div>
        )}

        {/* Options */}
        <div className="options-section">
          <label className="option-checkbox">
            <input
              type="checkbox"
              checked={useMock}
              onChange={(e) => setUseMock(e.target.checked)}
            />
            Use mock services (no API keys required)
          </label>
        </div>

        {/* Analyze Button */}
        <button
          className="analyze-button"
          onClick={handleAnalyze}
          disabled={!selectedFile || isAnalyzing}
        >
          {isAnalyzing ? 'Analyzing...' : 'Analyze Audio'}
        </button>
      </section>

      {/* Loading State */}
      {isAnalyzing && (
        <section className="upload-section">
          <div className="loading">
            <div className="spinner"></div>
            <p>Processing audio in streaming mode...</p>
          </div>
        </section>
      )}

      {/* Error Display */}
      {error && (
        <section className="upload-section">
          <div className="error-message">
            <p>❌ {error}</p>
          </div>
        </section>
      )}

      {/* Results Section */}
      {result && result.success && (
        <section className="results-section">
          <div className="results-header">
            <h2>Analysis Results</h2>
            <span className={`status-badge ${result.result.detected ? 'success' : 'warning'}`}>
              {result.result.detected ? 'Detection Found' : 'No Detection'}
            </span>
          </div>

          {/* Restart Warning Banner */}
          {result.streamingEvents?.restartOccurred && (
            <div className="restart-banner">
              <span className="restart-icon">🔄</span>
              <div className="restart-content">
                <strong>Restart Required!</strong>
                <p>
                  A beep was detected at {result.streamingEvents.restartTimestamp?.toFixed(3)}s,
                  overriding the earlier candidate start at {result.streamingEvents.restartPreviousTimestamp?.toFixed(3)}s.
                  Voicemail playback must restart from the beep timestamp.
                </p>
              </div>
            </div>
          )}

          {/* Main Result */}
          <div className="result-card">
            <h3>Detection Summary</h3>
            
            <div className="result-item">
              <span className="label">Final Timestamp</span>
              <span className="value highlight">
                {result.result.timestamp.toFixed(3)} seconds
              </span>
            </div>

            <div className="result-item">
              <span className="label">Detection Reason</span>
              <span className="value">
                {result.result.reason ? (
                  <span className={`reason-badge ${result.result.reason}`}>
                    {getReasonDisplay(result.result.reason)}
                  </span>
                ) : (
                  'N/A'
                )}
              </span>
            </div>

            <div className="result-item">
              <span className="label">Processing Time</span>
              <span className="value">{result.processingTime}ms</span>
            </div>

            {/* Explanation */}
            <div className="explanation">
              <p>💡 {result.result.explanation}</p>
            </div>
          </div>

          {/* Streaming Events Card */}
          {result.streamingEvents && (
            <div className="result-card">
              <h3>Streaming Events Timeline</h3>
              
              <div className="result-item">
                <span className="label">Candidate Start Triggered</span>
                <span className="value">
                  {result.streamingEvents.candidateStarted ? (
                    <span style={{ color: '#64c8ff' }}>
                      ✓ Yes at {result.streamingEvents.candidateTimestamp?.toFixed(3)}s
                      ({result.streamingEvents.candidateReason})
                    </span>
                  ) : (
                    <span style={{ color: '#888' }}>No</span>
                  )}
                </span>
              </div>

              <div className="result-item">
                <span className="label">Restart Occurred (Beep Override)</span>
                <span className="value">
                  {result.streamingEvents.restartOccurred ? (
                    <span style={{ color: '#ff6464' }}>
                      ⚠️ Yes - Beep at {result.streamingEvents.restartTimestamp?.toFixed(3)}s
                    </span>
                  ) : (
                    <span style={{ color: '#64ff96' }}>✓ No restart needed</span>
                  )}
                </span>
              </div>

              {result.streamingEvents.restartOccurred && (
                <div className="explanation" style={{ background: 'rgba(255, 100, 100, 0.1)', borderColor: '#ff6464' }}>
                  <p>
                    ⚠️ <strong>Compliance Note:</strong> The voicemail was initially started at{' '}
                    {result.streamingEvents.restartPreviousTimestamp?.toFixed(3)}s based on{' '}
                    {result.streamingEvents.candidateReason}, but a beep was detected later.
                    The consumer could NOT hear anything played before the beep.
                    Voicemail must be restarted from {result.streamingEvents.restartTimestamp?.toFixed(3)}s.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Debug Info Card */}
          {result.result.debug && (
            <div className="result-card">
              <h3>Detection Details</h3>
              
              {result.result.debug.beepDetectedAt !== undefined && (
                <div className="result-item">
                  <span className="label">Beep Detected At</span>
                  <span className="value">
                    {result.result.debug.beepDetectedAt.toFixed(3)}s
                  </span>
                </div>
              )}

              {result.result.debug.llmConfirmedAt !== undefined && (
                <div className="result-item">
                  <span className="label">LLM Confirmed At</span>
                  <span className="value">
                    {result.result.debug.llmConfirmedAt.toFixed(3)}s
                  </span>
                </div>
              )}

              {result.result.debug.silenceStartedAt !== undefined && (
                <div className="result-item">
                  <span className="label">Silence Started At</span>
                  <span className="value">
                    {result.result.debug.silenceStartedAt.toFixed(3)}s
                  </span>
                </div>
              )}

              {result.result.debug.silenceDuration !== undefined && (
                <div className="result-item">
                  <span className="label">Silence Duration</span>
                  <span className="value">
                    {result.result.debug.silenceDuration.toFixed(3)}s
                  </span>
                </div>
              )}

              {result.result.debug.transcript && (
                <div className="result-item" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '10px' }}>
                  <span className="label">Final Transcript</span>
                  <span className="value" style={{ fontStyle: 'italic', color: '#a0a0a0' }}>
                    "{result.result.debug.transcript}"
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Debug Toggle */}
          <div className="debug-section">
            <button
              className="debug-toggle"
              onClick={() => setShowDebug(!showDebug)}
            >
              <span>Raw Response Data</span>
              <span>{showDebug ? '▲' : '▼'}</span>
            </button>
            
            {showDebug && (
              <div className="debug-content">
                <pre>{JSON.stringify(result, null, 2)}</pre>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Info Section */}
      <section className="upload-section" style={{ marginTop: '30px' }}>
        <div className="result-card" style={{ margin: 0 }}>
          <h3>ℹ️ How It Works</h3>
          <p style={{ color: '#888', lineHeight: '1.6', marginBottom: '15px' }}>
            This system analyzes voicemail audio in real-time to detect when a greeting 
            ends and it's time to play your message. Detection uses three methods:
          </p>
          <ul style={{ color: '#a0a0a0', paddingLeft: '20px', lineHeight: '2' }}>
            <li><strong>🔔 Beep Detection:</strong> FFT analysis detects voicemail beeps (1000-1400 Hz)</li>
            <li><strong>🤖 LLM + Silence:</strong> AI detects greeting completion + short silence</li>
            <li><strong>🔇 Silence Fallback:</strong> Extended silence (1.2s+) triggers start</li>
          </ul>
          <p style={{ color: '#888', lineHeight: '1.6', marginTop: '15px' }}>
            <strong>Priority:</strong> Beep always overrides other signals to ensure compliance.
          </p>
        </div>
      </section>
    </div>
  );
}

export default App;
