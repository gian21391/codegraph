classdef Vehicle < handle
    methods
        function run(veh, u)
            d = veh.dxstate(0, u);
        end
    end
end
