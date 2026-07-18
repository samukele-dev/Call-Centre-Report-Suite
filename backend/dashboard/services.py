# backend/dashboard/services.py
import pandas as pd
import numpy as np
from io import BytesIO
from datetime import datetime, timedelta
import json
from django.db.models import Count, Sum, Q
from .models import OutcomeDescription, ProcessedData

class DataProcessor:
    @staticmethod
    def process_call_data(file_path, user):
        """Process the call data file and add description column"""
        try:
            # Read the Excel file
            df = pd.read_excel(file_path)
            
            # Validate required columns
            required_columns = ['contact_id', 'last_outcome']
            for col in required_columns:
                if col not in df.columns:
                    raise ValueError(f"Missing required column: {col}")
            
            # Get all outcome descriptions
            outcomes = OutcomeDescription.objects.all()
            outcome_map = {o.last_outcome: o.description for o in outcomes}
            
            # Add the new columns
            df['Description'] = df['last_outcome'].map(outcome_map)
            
            
            # Fill NaN values
            df['Description'] = df['Description'].fillna('Unknown Description')

              
            return df
            
        except Exception as e:
            raise Exception(f"Error processing file: {str(e)}")

class ReportGenerator:
    @staticmethod
    def generate_campaign_report(product_type='all'):
        """
        Generate the campaign report as shown in Image 3
        """

        # Convert to DataFrame for easier manipulation
        df = pd.DataFrame(list(data.values()))
        
        # Create report structure
        report_data = {
            'Metric': [
                # Campaign and Product
                'Campaign:',
                'Product:',
                '',
                # Lead Metrics
                'Total Leads',
                'Unworked Leads (New Leads)',
                'Successful Contacts',
                'True Contacts',
                'Conversion',
                'True Sales (post QA)',
                'Collections',
                'Number of missed 1st Collections',
                'NTU',
                'Cancellations/Lapse',
                '',
                # Conversion Rates
                'Contactability',
                'Lead to Sale Conversion',
                'Conversion to True Sale',
                'True Contacts to Sales',
                'True Sale to Collections',
                '',
                # Operational Metrics
                'Number of Calls to Leads',
                'Number of Calls Made',
                'Number of Calls per Lead',
                'Number of Agents',
                'Number of Working Days',
                '',
                # Unsuccessful Contacts Dispositions
                'Unsuccessful Contacts Dispositions',
                'Answering Machine',
                'Answering Machine Auto',
                'Answering Machine Autodial',
                'Auto Engaged',
                'Auto Dial Disconnected',
                'Busy Auto',
                'Busy',
                'Busy Tone',
                'Call Dropped',
                'Disconnected',
                'Disconnected Number Auto',
                'Disconnected Number Temporary',
                'Disconnected Number /Auto/Temporary',
                'Dropped',
                'Inbound After Hours Drop',
                'Inbound Abandon',
                'Flow Inbound Abandon',
                'Invalid Number',
                'New',
                'No Answer',
                'No Answer AutoDial',
                'Missed',
                'Multiple Calls',
                'Outbound Pre-Routing Drop',
                'Selected',
                'System Error',
                'Agent Error',
                'Bad Line Quality',
                'Call Picked Up',
                'Call Transferred',
                'Temporary Disconnected Number',
                '',
                # Unworkable Leads Dispositions
                'Unworkable Leads Dispositions',
                'Account In Arrears',
                'Account Suspended',
                'Already Contacted',
                'Agent Not Available',
                'Business Account',
                'Client Deceased',
                'Client Overage Limit',
                'Client Underage',
                'Customer drop',
                'Device Not Working',
                'Did Not Request',
                'Do not call',
                'Do Not Qualify Archived',
                'Does Not Qualify',
                'Does Not Qualify Over 90 days',
                'Does Not Qualify Prepaid',
                'Does Not Qualify Sim Only',
                'Does Not Need It Now',
                'Existing Client',
                'Existing Client - Altitude',
                'Existing Client - Bytes',
                'Existing Client - Store',
                'Previous insurance active',
                'Go to the Branch',
                'Inbound Queue Timeout Drop',
                'Language Barrier',
                'Lead Being Called',
                'Business/M2 Account',
                'Not Working Cannot Afford',
                'Over Age Limit',
                'Policy Lapse',
                'Premium Arrears/Debt',
                'Right Party Not available',
                'Sold at another call center',
                'Still Not Interested',
                'TPS Registered Number',
                'Under Age',
                'Unemployed',
                'Wrong number',
                '',
                # True Contacts
                'True Contacts',
                'Affordability',
                'Callback',
                'Call Back Hold',
                'Cannot Afford',
                'Client Hung Up',
                'Comprehensive /Norton',
                'Declined Sale',
                'NI Household Contents',
                'Norton',
                'Not Interested',
                'Not Interested Device Cost',
                'Not Interested Household Contents',
                'Not Interested Premium Cost',
                'Not Interested Upfront',
                'Not interested SMS',
                'NI House hold contents Price',
                'QA Duplicate',
                'QA Fail',
                'QA Rework',
                'Red deal R199',
                'Red deals R99',
                'Sale Made',
                'Sale SMS',
                'UPSELL'
            ]
        }
        
        # Create columns for each month (Jan-26, Feb-26, etc.)
        months = []
        current = period_start
        while current <= period_end:
            months.append(current.strftime('%b-%y'))
            # Move to next month
            if current.month == 12:
                current = current.replace(year=current.year + 1, month=1)
            else:
                current = current.replace(month=current.month + 1)
        
        # Add columns for each month (New Connection and Upgrades)
        for month in months:
            report_data[f"{month}_New_Connection"] = [0] * len(report_data['Metric'])
            report_data[f"{month}_Upgrades"] = [0] * len(report_data['Metric'])
        
        # Calculate metrics for each month
        for idx, month in enumerate(months):
            # Filter data for this month
            month_data = df[df['last_called_date'].dt.strftime('%b-%y') == month] if not df.empty else pd.DataFrame()
            
            if not month_data.empty:
                # Calculate metrics
                # Total Leads
                total_leads = len(month_data)
                
                # Sales
                sales = len(month_data[month_data['last_outcome'].isin(['SALE', 'UPSELL', 'Sale Made'])])
                
                # Fill in the metrics
                # Total Leads (row 3)
                report_data[f"{month}_New_Connection"][3] = int(total_leads * 0.7)  # Example: 70% New Connection
                report_data[f"{month}_Upgrades"][3] = total_leads - report_data[f"{month}_New_Connection"][3]
                
                # True Contacts (row 6)
                report_data[f"{month}_New_Connection"][6] = int(true_contacts * 0.7)
                report_data[f"{month}_Upgrades"][6] = true_contacts - report_data[f"{month}_New_Connection"][6]
                
                # Sales (row 8)
                report_data[f"{month}_New_Connection"][8] = int(sales * 0.7)
                report_data[f"{month}_Upgrades"][8] = sales - report_data[f"{month}_New_Connection"][8]
                
                # Calculate disposition metrics
                outcome_counts = month_data['last_outcome'].value_counts()
                
                # Map outcomes to rows
                outcome_to_row = {
                    'AM': 27,  # Answering Machine
                    'AMA': 28,  # Answering Machine Auto
                    'BUSY': 30,  # Busy
                    'CD': 31,  # Call Dropped
                    'DISC': 32,  # Disconnected
                    'INV': 39,  # Invalid Number
                    'NA': 40,  # No Answer
                    'SALE': 105,  # Sale Made
                    'UPSELL': 106,  # UPSELL
                    # Add more mappings as needed
                }
                
                for outcome, count in outcome_counts.items():
                    if outcome in outcome_to_row:
                        row_idx = outcome_to_row[outcome]
                        report_data[f"{month}_New_Connection"][row_idx] = int(count * 0.7)
                        report_data[f"{month}_Upgrades"][row_idx] = count - report_data[f"{month}_New_Connection"][row_idx]
        
        return pd.DataFrame(report_data)
    
    @staticmethod
    def generate_excel_report(df, report_name):
        """Generate formatted Excel file"""
        output = BytesIO()
        
        with pd.ExcelWriter(output, engine='xlsxwriter') as writer:
            # Write to Excel
            df.to_excel(writer, sheet_name='Call Center Report', index=False)
            
            workbook = writer.book
            worksheet = writer.sheets['Call Center Report']
            
            # Define formats
            header_format = workbook.add_format({
                'bold': True,
                'bg_color': '#366092',
                'font_color': 'white',
                'border': 1,
                'align': 'center',
                'valign': 'vcenter'
            })
            
            subheader_format = workbook.add_format({
                'bold': True,
                'bg_color': '#C5D9F1',
                'border': 1,
                'align': 'center'
            })
            
            metric_format = workbook.add_format({
                'bold': True,
                'bg_color': '#F2F2F2',
                'border': 1
            })
            
            number_format = workbook.add_format({
                'border': 1,
                'num_format': '#,##0'
            })
            
            # Set column widths
            worksheet.set_column('A:A', 50)  # Metric column
            for col in range(1, len(df.columns)):
                worksheet.set_column(col, col, 15)
            
            # Apply formatting
            for row in range(len(df)):
                for col in range(len(df.columns)):
                    if row == 0:  # Header row
                        cell_value = df.columns[col]
                        if '_' in str(cell_value):
                            month = cell_value.split('_')[0]
                            worksheet.write(row, col, month, header_format)
                        else:
                            worksheet.write(row, col, cell_value, header_format)
                    elif row == 1:  # Sub-header
                        cell_value = df.columns[col]
                        if 'New_Connection' in str(cell_value):
                            worksheet.write(row, col, 'New Connection', subheader_format)
                        elif 'Upgrades' in str(cell_value):
                            worksheet.write(row, col, 'Upgrades', subheader_format)
                        else:
                            worksheet.write(row, col, '', subheader_format)
                    else:
                        cell_value = df.iloc[row, col]
                        if col == 0:  # Metric column
                            worksheet.write(row + 1, col, cell_value, metric_format)
                        else:  # Data columns
                            try:
                                num_value = float(cell_value)
                                worksheet.write(row + 1, col, num_value, number_format)
                            except:
                                worksheet.write(row + 1, col, cell_value)
            
            # Add some merged cells for better presentation
            worksheet.merge_range('A1:A2', 'Metric', header_format)
        
        output.seek(0)
        return output
    
    @staticmethod
    def generate_analysis_report(period_start, period_end):
        """Generate detailed analysis report"""
        # This would be your second report type
        # Implement based on your specific analysis requirements
        
        # For now, return a simple DataFrame
        analysis_data = {
            'Analysis Metric': [
                'Total Calls by Hour',
                'Average Call Duration',
                'Success Rate by Agent',
                'Common Outcome Patterns',
                'Lead Source Performance',
                'Geographic Distribution',
                'Trend Analysis',
                'Peak Hours Analysis',
                'Agent Performance Ranking',
                'Conversion Funnel Analysis'
            ],
            'Value': [0] * 10,
            'Insight': [''] * 10,
            'Recommendation': [''] * 10
        }
        
        return pd.DataFrame(analysis_data)