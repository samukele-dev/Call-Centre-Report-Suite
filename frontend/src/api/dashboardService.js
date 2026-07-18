// src/api/dashboardService.js - COMPLETE FIXED VERSION
import { dashboardAPI } from './apiConfig';

class DashboardService {

  // ========== HELPER ==========
  // Single shared way to get the axios instance
  static async _api() {
    return import('./apiConfig').then(mod => mod.default);
  }

  // ========== OUTCOME DESCRIPTIONS ==========

  static async getOutcomeDescriptions() {
    try {
      const response = await dashboardAPI.getOutcomeDescriptions();
      return response;
    } catch (error) {
      console.error('API Error:', error);
      return { success: false, error: error.error || 'API request failed' };
    }
  }

  static async createOutcomeDescription(data) {
    try {
      const api = await DashboardService._api();
      const response = await api.post('/api/outcomes/', data);
      return { success: true, data: response.data };
    } catch (error) {
      return { success: false, error: error.response?.data || 'Failed to create outcome' };
    }
  }

  static async updateOutcomeDescription(id, data) {
    try {
      const api = await DashboardService._api();
      const response = await api.put(`/api/outcomes/${id}/`, data);
      return { success: true, data: response.data };
    } catch (error) {
      return { success: false, error: error.response?.data || 'Failed to update outcome' };
    }
  }

  static async deleteOutcomeDescription(id) {
    try {
      const api = await DashboardService._api();
      await api.delete(`/api/outcomes/${id}/`);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.response?.data || 'Failed to delete outcome' };
    }
  }

  static async bulkUploadOutcomes(file) {
    try {
      const formData = new FormData();
      formData.append('file', file);
      const api = await DashboardService._api();
      const response = await api.post('/api/outcomes/bulk_upload/', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      return { success: true, data: response.data };
    } catch (error) {
      return { success: false, error: error.response?.data || 'Failed to upload file' };
    }
  }

  static async exportOutcomes() {
    try {
      const api = await DashboardService._api();
      const response = await api.get('/api/outcomes/export/', { responseType: 'blob' });
      return { success: true, data: response.data };
    } catch (error) {
      return { success: false, error: 'Failed to export outcomes' };
    }
  }

  // ========== CAMPAIGNS ==========

  static async getCampaigns() {
    try {
      const api = await DashboardService._api();
      const response = await api.get('/api/campaigns/');
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Error fetching campaigns:', error);
      return { success: false, error: error.response?.data || error.message, data: [] };
    }
  }

  static async getCampaign(id) {
    try {
      const api = await DashboardService._api();
      const response = await api.get(`/api/campaigns/${id}/`);
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Error fetching campaign:', error);
      return { success: false, error: error.response?.data || error.message };
    }
  }

  static async createCampaign(data) {
    try {
      const api = await DashboardService._api();
      const response = await api.post('/api/campaigns/', data);
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Error creating campaign:', error);
      return { success: false, error: error.response?.data || error.message };
    }
  }

  static async getCampaignStats(campaignId) {
    try {
      const api = await DashboardService._api();
      const response = await api.get(`/api/campaigns/${campaignId}/stats/`);
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Error fetching campaign stats:', error);
      return { success: false, error: error.response?.data || error.message };
    }
  }

  static async getCampaignActivity(campaignId) {
    try {
      const api = await DashboardService._api();
      const response = await api.get(`/api/campaigns/${campaignId}/recent_activity/`);
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Error fetching campaign activity:', error);
      return { success: false, error: error.response?.data || error.message };
    }
  }

  // ========== FILE UPLOADS ==========

  static async uploadCallDataFile(file, campaignId = null, delimiter = ',', hasHeaders = true) {
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('delimiter', delimiter);
      formData.append('has_headers', hasHeaders.toString());
      if (campaignId) {
        formData.append('campaign', campaignId);
      }

      const api = await DashboardService._api();
      const response = await api.post('/api/files/', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Upload error:', error);
      return {
        success: false,
        error: error.response?.data?.error || error.response?.data || 'Upload failed'
      };
    }
  }

  static async getUploadedFiles(campaignId = null) {
    try {
      const params = campaignId ? `?campaign_id=${campaignId}` : '';
      const api = await DashboardService._api();
      const response = await api.get(`/api/files/${params}`);
      return { success: true, data: response.data };
    } catch (error) {
      return { success: false, error: error.error || 'Failed to fetch files' };
    }
  }

  static async getFilePreview(fileId) {
    try {
      const response = await dashboardAPI.previewFile(fileId);
      return response;
    } catch (error) {
      return { success: false, error: error.error || 'Failed to fetch preview' };
    }
  }

  static async downloadProcessedFile(fileId, fileName) {
    try {
      const api = await DashboardService._api();
      const response = await api.get(`/api/files/${fileId}/download_processed/`, {
        responseType: 'blob'
      });

      if (response.data instanceof Blob) {
        // Guard: check if backend returned a JSON error as a blob
        if (response.data.type === 'application/json') {
          const text = await response.data.text();
          try {
            const errorData = JSON.parse(text);
            return { success: false, error: errorData.error || 'Error downloading file' };
          } catch {
            // Not JSON — fall through to success
          }
        }
        return {
          success: true,
          data: response.data,
          fileName: fileName ? `processed_${fileName}` : 'processed_data.xlsx'
        };
      }
      return { success: false, error: 'Invalid response format' };
    } catch (error) {
      console.error('Download processed file error:', error);
      return {
        success: false,
        error: error.response?.data?.error || error.message || 'Failed to download file'
      };
    }
  }

  // ========== TEMPLATES ==========

  /**
   * FIX: accepts campaignId so only templates for the open campaign are returned.
   * Pass campaignId from useParams() — e.g. getTemplates(id)
   */
  static async getTemplates(campaignId = null) {
    try {
      const params = campaignId ? `?campaign_id=${campaignId}` : '';
      const api = await DashboardService._api();
      const response = await api.get(`/api/templates/${params}`);
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Error fetching templates:', error);
      return { success: false, error: error.response?.data || error.message, data: [] };
    }
  }

  /**
   * FIX: accepts campaignId so the uploaded template is linked to the correct campaign.
   * Pass campaignId from useParams() — e.g. uploadTemplate(file, name, desc, id)
   */
  static async uploadTemplate(file, name, description, campaignId = null) {
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('name', name);
      formData.append('description', description || '');
      if (campaignId) {
        formData.append('campaign_id', campaignId);  // links template to this campaign
      }

      const api = await DashboardService._api();
      const response = await api.post('/api/templates/', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      return { success: true, ...response.data };
    } catch (error) {
      console.error('Error uploading template:', error);
      return { success: false, error: error.response?.data || error.message };
    }
  }

  static async getTemplateSheets(templateId) {
    try {
      const api = await DashboardService._api();
      const response = await api.get(`/api/templates/${templateId}/sheets/`);
      return response.data;
    } catch (error) {
      console.error('Error fetching template sheets:', error);
      return { success: false, error: error.response?.data || error.message };
    }
  }

  static async extractTemplateSheets(templateId) {
    try {
      const api = await DashboardService._api();
      const response = await api.post(`/api/templates/${templateId}/extract-sheets/`);
      return response.data;
    } catch (error) {
      console.error('Error extracting sheets:', error);
      return { success: false, error: error.response?.data || error.message };
    }
  }

  static async configureTemplateMapping(templateId, mappings) {
    try {
      const api = await DashboardService._api();
      const response = await api.post(`/api/templates/${templateId}/configure_mapping/`, {
        sheet_mappings: mappings
      });
      return response.data;
    } catch (error) {
      console.error('Error configuring mapping:', error);
      return { success: false, error: error.response?.data || error.message };
    }
  }

  // ========== REPORTS ==========

  /**
   * FIX: requires campaignId so the report is generated only from that campaign's data.
   * Pass campaignId from useParams() — e.g. generateCampaignReport(id)
   */
  static async generateCampaignReport(campaignId) {
    try {
      if (!campaignId) {
        return { success: false, error: 'campaign_id is required to generate a report.' };
      }
      console.log(`🚀 Generating campaign report for campaign ${campaignId}...`);
      const api = await DashboardService._api();
      const response = await api.post('/api/reports/generate_campaign/', {
        campaign_id: campaignId   // backend requires this to scope data
      });
      return { success: true, data: response.data };
    } catch (error) {
      console.error('generateCampaignReport error:', error);
      const errorData = error.response?.data;
      return {
        success: false,
        error: errorData?.error || (typeof errorData === 'object' ? JSON.stringify(errorData) : errorData) || 'Failed to generate report',
        status: error.response?.status,
        details: errorData
      };
    }
  }

  /**
   * FIX: requires campaignId so the analysis uses the correct campaign's Pivot data
   * and the correct campaign's template.
   * Pass campaignId from useParams() — e.g. generateCampaignAnalysis(templateId, sheetName, id)
   */
  static async generateCampaignAnalysis(templateId, campaignName, campaignId) {
    try {
      if (!campaignId) {
        return { success: false, error: 'campaign_id is required to generate analysis.' };
      }
      const api = await DashboardService._api();
      const response = await api.post('/api/reports/generate_campaign_analysis/', {
        template_id: templateId,
        campaign_name: campaignName,
        campaign_id: campaignId   // backend uses this to scope the Pivot data lookup
      });
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Error generating campaign analysis:', error);
      return { success: false, error: error.response?.data || error.message };
    }
  }

  /**
   * FIX: accepts campaignId so the list only shows reports for the open campaign.
   * Pass campaignId from useParams() — e.g. getReports(id)
   */
  static async getReports(campaignId = null) {
    try {
      const params = campaignId ? `?campaign_id=${campaignId}` : '';
      const api = await DashboardService._api();
      const response = await api.get(`/api/reports/${params}`);
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Error fetching reports:', error);
      return {
        success: false,
        error: error.response?.data?.error || 'Failed to fetch reports'
      };
    }
  }

  static async downloadReport(reportId, fileName) {
    try {
      const api = await DashboardService._api();
      const response = await api.get(`/api/reports/${reportId}/download/`, {
        responseType: 'blob'
      });

      if (response.data instanceof Blob) {
        // Guard: check if backend returned a JSON error as a blob
        if (response.data.type === 'application/json') {
          const text = await response.data.text();
          try {
            const errorData = JSON.parse(text);
            return { success: false, error: errorData.error || 'Error downloading report' };
          } catch {
            // Not JSON — fall through to success
          }
        }
        return {
          success: true,
          data: response.data,
          fileName: fileName || 'report.xlsx'
        };
      }
      return { success: false, error: 'Invalid response format' };
    } catch (error) {
      console.error('Download report error:', error);
      return {
        success: false,
        error: error.response?.data?.error || error.message || 'Failed to download report'
      };
    }
  }

  static async generateAnalysisReport() {
    try {
      const api = await DashboardService._api();
      const response = await api.post('/api/reports/generate-analysis/', {});
      return response.data;
    } catch (error) {
      console.error('Error generating analysis report:', error);
      return { success: false, error: error.response?.data?.error || 'Failed to generate analysis report' };
    }
  }

  // ========== DASHBOARD STATS ==========

  static async getDashboardStats(campaignId = null) {
    try {
      const params = campaignId ? `?campaign_id=${campaignId}` : '';
      const api = await DashboardService._api();
      const response = await api.get(`/api/stats/${params}`);
      return { success: true, data: response.data };
    } catch (error) {
      return { success: false, error: error.error || 'Failed to fetch stats' };
    }
  }
}

export default DashboardService;