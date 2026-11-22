classdef Vehicle < handle
    methods
        function run(veh)
            veh.deriv(1);
        end
    end
end
