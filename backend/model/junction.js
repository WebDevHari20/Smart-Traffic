const supabase = require('../db')

class junction {
  // Detect which ambulance column exists in the table schema.
  static async getAmbulanceColumnName() {
    const candidateColumns = [
      'ambulance',
      'ambulance_b',
      'ambulance_bool',
      'is_ambulance',
      'ambulance_present',
      'Ambulance_b',
      'Ambulance_bool',
      'Ambulance',
    ];

    for (const columnName of candidateColumns) {
      const { error } = await supabase
        .from('junctions')
        .select(columnName)
        .limit(1);

      if (!error) {
        return columnName;
      }
    }

    throw new Error(
      'Ambulance column not found. Expected one of: ambulance, ambulance_b, ambulance_bool, is_ambulance, ambulance_present, Ambulance_b, Ambulance_bool, Ambulance'
    );
  }

  // Detect which signal status column exists in the table schema.
  static async getSignalStatusColumnName() {
    const candidateColumns = [
      'signal_status',
      'signal',
      'status',
      'Signal_status',
      'Signal',
      'Status',
    ];

    for (const columnName of candidateColumns) {
      const { error } = await supabase
        .from('junctions')
        .select(columnName)
        .limit(1);

      if (!error) {
        return columnName;
      }
    }

    throw new Error(
      'Signal status column not found. Expected one of: signal_status, signal, status, Signal_status, Signal, Status'
    );
  }

  // Fetch all junction rows.
  static async find() {
    const { data, error } = await supabase.from('junctions').select('*');

    if (error) {
      throw new Error(error.message);
    }
    else{
      return data
    }
  }

  // Get the 3 junctions, sum vehicle_count, and check if any ambulance flag is true.
  static async getVehicleCountSummary() {
    const ambulanceColumn = await this.getAmbulanceColumnName();

    const { data, error } = await supabase
      .from('junctions')
      .select(`id,name,vehicle_count,${ambulanceColumn}`)
      .order('id', { ascending: true })
      .limit(3);

    if (error) {
      throw new Error(error.message);
    }

    // Sum total vehicles across junctions.
    const totalVehicleCount = data.reduce(
      (sum, junctionRow) => sum + (junctionRow.vehicle_count || 0),
      0
    );

    // Check whether at least one junction currently has ambulance=true.
    const hasAnyAmbulance = data.some((junctionRow) => junctionRow[ambulanceColumn] === true);

    return {
      junctions: data,
      totalVehicleCount,
      hasAnyAmbulance,
      ambulanceColumn,
    };
  }

  // Set ambulance flag for all 3 configured junction ids.
  static async updateAmbulanceForAllJunctions(isAmbulancePresent) {
    const ambulanceColumn = await this.getAmbulanceColumnName();

    const { data, error } = await supabase
      .from('junctions')
      .update({ [ambulanceColumn]: !!isAmbulancePresent })
      .in('id', [1, 2, 3])
      .select('*');

    if (error) {
      throw new Error(error.message);
    }

    return data;
  }

  // Read summary and propagate ambulance=true to all 3 junctions if any one is true.
  static async syncAmbulanceStatus() {
    const summary = await this.getVehicleCountSummary();

    if (summary.hasAnyAmbulance) {
      await this.updateAmbulanceForAllJunctions(true);
    }

    return summary;
  }

  // Update each configured junction with vehicle count, ambulance, and signal status.
  static async updateJunctionMetricsBatch(junctionMetrics) {
    const ambulanceColumn = await this.getAmbulanceColumnName();
    const signalStatusColumn = await this.getSignalStatusColumnName();

    const updates = await Promise.all(
      junctionMetrics.map(async (metric) => {
        const payload = {
          vehicle_count: Number(metric.vehicleCount || 0),
          [ambulanceColumn]: !!metric.hasAmbulance,
          [signalStatusColumn]: String(metric.signalStatus || 'RED').toUpperCase(),
        };

        const { data, error } = await supabase
          .from('junctions')
          .update(payload)
          .eq('id', metric.junctionId)
          .select('*');

        if (error) {
          throw new Error(error.message);
        }

        return Array.isArray(data) && data.length ? data[0] : null;
      })
    );

    return {
      updatedRows: updates.filter(Boolean),
      ambulanceColumn,
      signalStatusColumn,
    };
  }


}

module.exports = junction;

