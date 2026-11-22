classdef Vehicle < handle
    methods
        function run(veh, u)
            d = veh.deriv(0, u);
        end
    end
end
