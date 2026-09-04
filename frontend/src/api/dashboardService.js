// src/api/dashboardService.js - COMPLETE FIXED VERSION
import { dashboardAPI } from './apiConfig';

class DashboardService {

  // ========== HELPER ==========
  // Single shared way to get the axios instance
  static async _api() {
    return import('./apiConfig').then(mod => mod.default);
  }

  // ========== OUTCOME SETS ==========

  static async getOutcomeSets() {
    try {
      const api = await DashboardService._api();
      const response = await api.get('/api/outcome-sets/');
      return { success: true, data: response.data };
    } catch (error) {
      return { success: false, error: error.response?.data || 'Failed to fetch outcome sets', data: [] };
    }
  }

  static async createOutcomeSet(data) {
    try {
      const api = await DashboardService._api();
      const response = await api.post('/api/outcome-sets/', data);
      return { success: true, data: response.data };
    } catch (error) {
      return { success: false, error: error.response?.data || 'Failed to create outcome set' };
    }
  }

  static async updateOutcomeSet(id, data) {
    try {
      const api = await DashboardService._api();
      const response = await api.patch(`/api/outcome-sets/${id}/`, data);
      return { success: true, data: response.data };
    } catch (error) {
      return { success: false, error: error.response?.data || 'Failed to update outcome set' };
    }
  }

  static async deleteOutcomeSet(id) {
    try {
      const api = await DashboardService._api();
      await api.delete(`/api/outcome-sets/${id}/`);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.response?.data || 'Failed to delete outcome set' };
    }
  }

  // ========== OUTCOME DESCRIPTIONS ==========

  static async getOutcomeDescriptions(params = {}) {
    try {
      const api = await DashboardService._api();
      const query = {};
      if (params.search) query.search = params.search;
      if (params.outcome_set) query.outcome_set = params.outcome_set;
      const response = await api.get('/api/outcomes/', { params: query });
      return { success: true, data: response.data };
    } catch (error) {
      console.error('API Error:', error);
      return { success: false, error: error.response?.data || 'API request failed' };
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

  static async bulkUploadOutcomes(file, outcomeSetId = null) {
    try {
      const formData = new FormData();
      formData.append('file', file);
      if (outcomeSetId) formData.append('outcome_set', outcomeSetId);
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

  // ========== QA REVIEW ==========

  static async getQARecords({ campaignIds = [], startDate = null, endDate = null, startTime = null, endTime = null, outcomes = [], search = null, page = 1, pageSize = 50 } = {}) {
    try {
      const api = await DashboardService._api();
      const params = {
        campaign_ids: campaignIds.join(','),
        page,
        page_size: pageSize,
      };
      if (startDate) params.start_date = startDate;
      if (endDate) params.end_date = endDate;
      if (startDate && startTime) params.start_time = startTime;
      if (endDate && endTime) params.end_time = endTime;
      if (outcomes.length > 0) params.outcomes = outcomes.join(',');
      if (search) params.search = search;

      const response = await api.get('/api/qa/records/', { params });
      return { success: true, data: response.data };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.error || error.response?.data || 'Failed to fetch QA records',
        data: { count: 0, results: [], page: 1, num_pages: 1, last_synced: null }
      };
    }
  }

  static async getQAOutcomes(campaignIds = []) {
    try {
      const api = await DashboardService._api();
      const response = await api.get('/api/qa/outcomes/', { params: { campaign_ids: campaignIds.join(',') } });
      return { success: true, data: response.data };
    } catch (error) {
      return { success: false, error: error.response?.data || 'Failed to fetch outcomes', data: [] };
    }
  }

  static async syncQACache(campaignIds = [], signal = null) {
    try {
      const api = await DashboardService._api();
      const response = await api.post(
        '/api/qa/sync/',
        { campaign_ids: campaignIds },
        signal ? { signal } : undefined
      );
      return { success: true, data: response.data };
    } catch (error) {
      if (error.code === 'ERR_CANCELED') {
        return { success: false, aborted: true };
      }
      return { success: false, error: error.response?.data?.error || error.response?.data || 'Failed to sync QA data' };
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

  static async updateCampaign(id, data) {
    try {
      const api = await DashboardService._api();
      const response = await api.patch(`/api/campaigns/${id}/`, data);
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Error updating campaign:', error);
      return { success: false, error: error.response?.data || error.message };
    }
  }

  static async deleteCampaign(id) {
    try {
      const api = await DashboardService._api();
      await api.delete(`/api/campaigns/${id}/`);
      return { success: true };
    } catch (error) {
      console.error('Error deleting campaign:', error);
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

  static async getCampaignSourceLists(campaignId) {
    try {
      const api = await DashboardService._api();
      const response = await api.get(`/api/campaigns/${campaignId}/source_lists/`);
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Error fetching source lists:', error);
      return {
        success: false,
        error: error.response?.data?.error || error.response?.data || 'Failed to fetch source lists',
        data: []
      };
    }
  }

  static async syncCampaignFromDatabase(campaignId, startDate = null, endDate = null, listIds = null, startTime = null, endTime = null) {
    try {
      const api = await DashboardService._api();
      const response = await api.post(`/api/campaigns/${campaignId}/sync_from_database/`, {
        start_date: startDate || undefined,
        end_date: endDate || undefined,
        start_time: startDate && startTime ? startTime : undefined,
        end_time: endDate && endTime ? endTime : undefined,
        list_ids: listIds && listIds.length > 0 ? listIds : undefined,
      });
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Database sync error:', error);
      return {
        success: false,
        error: error.response?.data?.error || error.response?.data || 'Database sync failed'
      };
    }
  }

  // ========== CAMPAIGN SYNC (NEW) ==========

  static async syncCampaigns(onlyActive = true) {
    try {
      const api = await DashboardService._api();
      const response = await api.post('/api/campaigns/sync_campaigns/', {
        only_active: onlyActive
      });
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Campaign sync error:', error);
      return {
        success: false,
        error: error.response?.data?.error || error.response?.data || 'Campaign sync failed'
      };
    }
  }

  static async testConnection() {
    try {
      const api = await DashboardService._api();
      const response = await api.get('/api/campaigns/test_connection/');
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Connection test error:', error);
      return {
        success: false,
        error: error.response?.data?.error || error.response?.data || 'Connection test failed'
      };
    }
  }

  static async getSourceCampaigns(onlyActive = true) {
    try {
      const api = await DashboardService._api();
      const response = await api.get(`/api/campaigns/source_campaigns/?only_active=${onlyActive}`);
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Get source campaigns error:', error);
      return {
        success: false,
        error: error.response?.data?.error || error.response?.data || 'Failed to fetch source campaigns'
      };
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

  static async uploadTemplate(file, name, description, campaignId = null) {
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('name', name);
      formData.append('description', description || '');
      if (campaignId) {
        formData.append('campaign_id', campaignId);
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

  static async generateCampaignReport(campaignId) {
    try {
      if (!campaignId) {
        return { success: false, error: 'campaign_id is required to generate a report.' };
      }
      console.log(`🚀 Generating campaign report for campaign ${campaignId}...`);
      const api = await DashboardService._api();
      const response = await api.post('/api/reports/generate_campaign/', {
        campaign_id: campaignId
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

  static async generateCampaignAnalysis(templateId, campaignName, campaignId) {
    try {
      if (!campaignId) {
        return { success: false, error: 'campaign_id is required to generate analysis.' };
      }
      const api = await DashboardService._api();
      const response = await api.post('/api/reports/generate_campaign_analysis/', {
        template_id: templateId,
        campaign_name: campaignName,
        campaign_id: campaignId
      });
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Error generating campaign analysis:', error);
      return { success: false, error: error.response?.data || error.message };
    }
  }

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